/**
 * HeyAustin (Listar) venue events.
 *
 * Events live in the `facebook_events` CPT and are exposed via:
 *   GET https://heyaustin.com/wp-json/listar/v1/event/list?page=N&per_page=70
 *
 * Each event includes venue_name / venue_website. We resolve the listing from
 * calendar_url (…/listing/slug/), then filter the city-wide event feed to that
 * venue by name and/or website host.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";

export function isHeyAustinSource(pageUrl: string): boolean {
	return /heyaustin\.com/i.test(pageUrl);
}

function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#038;/g, "&")
		.replace(/&#039;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.replace(/['']/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function hostOf(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
			.replace(/^www\./, "")
			.toLowerCase();
	} catch {
		return null;
	}
}

interface ListarEvent {
	ID?: string;
	id?: string;
	post_title?: string;
	post_content?: string;
	post_name?: string;
	guid?: string;
	event_starts_sort_field?: string;
	venue_name?: string;
	venue_website?: string;
	venue_phone?: string;
	venue_desc?: string;
	facebook?: string;
	fb_event_uri?: string;
	image?: {
		full?: { url?: string };
		medium?: { url?: string };
		thumb?: { url?: string };
	};
}

interface ListarListResponse {
	success?: boolean;
	pagination?: { page: number; per_page: number; max_page: number; total: number };
	data?: ListarEvent[];
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 events-platform-heyaustin",
			Accept: "application/json",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return (await res.json()) as T;
}

/** Resolve listing title + optional website from /listing/slug/ or WP id. */
export async function resolveHeyAustinListing(listingUrl: string): Promise<{
	listingId: string | null;
	title: string | null;
	website: string | null;
	link: string;
}> {
	const origin = new URL(listingUrl).origin;
	const slug =
		listingUrl.match(/\/listing\/([a-z0-9-]+)\/?/i)?.[1] ??
		listingUrl.match(/job_listing[=/](\d+)/i)?.[1] ??
		null;

	if (slug && /^\d+$/.test(slug)) {
		const jl = await fetchJson<{
			id: number;
			title?: { rendered?: string };
			link?: string;
			meta?: { _company_website?: string };
		}>(`${origin}/wp-json/wp/v2/job_listing/${slug}`);
		return {
			listingId: String(jl.id),
			title: jl.title?.rendered ? stripHtml(jl.title.rendered) : null,
			website: jl.meta?._company_website ?? null,
			link: jl.link ?? listingUrl,
		};
	}

	if (slug) {
		const search = await fetchJson<
			Array<{
				id: number;
				slug: string;
				title?: { rendered?: string };
				link?: string;
				meta?: { _company_website?: string };
			}>
		>(`${origin}/wp-json/wp/v2/job_listing?slug=${encodeURIComponent(slug)}&per_page=5`);
		const hit = Array.isArray(search) ? search.find((x) => x.slug === slug) ?? search[0] : null;
		if (hit) {
			return {
				listingId: String(hit.id),
				title: hit.title?.rendered ? stripHtml(hit.title.rendered) : null,
				website: hit.meta?._company_website ?? null,
				link: hit.link ?? listingUrl,
			};
		}
	}

	// Fallback: place/view by numeric id in path
	const idMatch = listingUrl.match(/[?&]id=(\d+)/i);
	if (idMatch) {
		const place = await fetchJson<{
			success?: boolean;
			data?: { ID?: string; post_title?: string };
		}>(`${origin}/wp-json/listar/v1/place/view?id=${idMatch[1]}`);
		return {
			listingId: place.data?.ID ?? idMatch[1],
			title: place.data?.post_title ?? null,
			website: null,
			link: listingUrl,
		};
	}

	return { listingId: null, title: null, website: null, link: listingUrl };
}

function venueMatches(
	event: ListarEvent,
	listingTitle: string | null,
	venueName: string,
	websiteUrl: string | null | undefined,
): boolean {
	const eventVenue = normalizeName(event.venue_name || "");
	const targets = [listingTitle, venueName]
		.filter(Boolean)
		.map((t) => normalizeName(t!))
		.filter((t) => t.length >= 3);

	for (const t of targets) {
		if (!eventVenue) continue;
		if (eventVenue === t) return true;
		if (eventVenue.includes(t) || t.includes(eventVenue)) return true;
		// token overlap (brushy street commons ↔ brushy street)
		const et = new Set(eventVenue.split(" "));
		const tt = t.split(" ").filter((w) => w.length > 2);
		const overlap = tt.filter((w) => et.has(w)).length;
		if (tt.length >= 2 && overlap >= Math.min(2, tt.length)) return true;
	}

	const eventHost = hostOf(event.venue_website);
	const siteHost = hostOf(websiteUrl ?? undefined);
	if (eventHost && siteHost && eventHost === siteHost) return true;

	return false;
}

function startsAtIso(raw: string | undefined): string | null {
	if (!raw) return null;
	// "2026-07-12T20:00:00-05:00" or with Z
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

export async function fetchHeyAustinEvents(params: {
	calendarUrl: string;
	venueName: string;
	address: string | null;
	websiteUrl?: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxPages?: number;
}): Promise<PartnerEvent[]> {
	const origin = new URL(params.calendarUrl).origin;
	const listing = await resolveHeyAustinListing(params.calendarUrl);
	const maxPages = params.maxPages ?? 25;
	const cutoff = Date.now() + params.scrapeDaysAhead * 864e5;

	const matched: ListarEvent[] = [];
	let maxPage = 1;

	for (let page = 1; page <= maxPages; page++) {
		const url = `${origin}/wp-json/listar/v1/event/list?page=${page}&per_page=70`;
		const body = await fetchJson<ListarListResponse>(url);
		if (body.pagination?.max_page) maxPage = body.pagination.max_page;
		const batch = body.data ?? [];
		if (batch.length === 0) break;

		for (const ev of batch) {
			if (
				venueMatches(ev, listing.title, params.venueName, params.websiteUrl ?? listing.website)
			) {
				matched.push(ev);
			}
		}

		if (page >= maxPage) break;
	}

	const out: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const ev of matched) {
		const startsAt = startsAtIso(ev.event_starts_sort_field);
		if (!startsAt) continue;
		const t = new Date(startsAt).getTime();
		if (t < Date.now() - 864e5) continue;
		if (t > cutoff) continue;

		const title = stripHtml(ev.post_title || "").trim();
		if (!title) continue;

		const id = String(ev.ID ?? ev.id ?? "");
		const key = id || `${title}|${startsAt}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const image =
			ev.image?.full?.url ?? ev.image?.medium?.url ?? ev.image?.thumb?.url ?? null;
		const description = ev.post_content ? stripHtml(ev.post_content) : null;
		const sourceUrl =
			ev.guid ||
			(ev.post_name ? `${origin}/events/${ev.post_name}/` : listing.link);
		const ticketUrl = ev.fb_event_uri || ev.facebook || sourceUrl;

		out.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: params.venueName,
				address: params.address,
				description: description && description.length > 40 ? description : null,
				image_url: image,
				source_url: sourceUrl,
				source_partner: "heyaustin",
				source_event_id: id ? `ha-${id}` : null,
				raw_date_text: ev.event_starts_sort_field ?? startsAt,
				price_text: null,
				ticket_url: ticketUrl,
				confidence: 0.9,
			}),
		);
	}

	out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return out;
}
