/**
 * Lake Travis (Listar) — venue places + city-wide event feed.
 *
 * Places:  GET {origin}/wp-json/listar/v1/place/list|view
 * Events:  GET {origin}/wp-json/listar/v1/event/list
 * Reviews: GET {origin}/wp-json/listar/v1/comments?post_id=
 *
 * Brand site slug: laketravis (NOT heyaustin).
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import {
	listarAllPlaces,
	listarComments,
	listarEmail,
	listarEventList,
	listarFetchJson,
	listarImageUrl,
	listarNum,
	listarOrigin,
	listarPlaceId,
	listarPlaceView,
	stripListarHtml,
	type ListarEvent,
	type ListarOpeningDay,
	type ListarPlace,
} from "./listar-client";

export const LAKETRAVIS_ORIGIN = listarOrigin("laketravis");
export const LAKETRAVIS_SITE_SLUG = "laketravis";

export function isLakeTravisSource(pageUrl: string): boolean {
	return /laketravis\.com/i.test(pageUrl);
}

export type MappedListarVenue = {
	external_place_id: string;
	slug: string;
	name: string;
	description: string | null;
	address: string | null;
	lat: number | null;
	lng: number | null;
	phone: string | null;
	email: string | null;
	website_url: string | null;
	listing_url: string | null;
	rating_avg: number;
	rating_count: number;
	status: "draft" | "published" | "archived";
	image_url: string | null;
	category_slug: string | null;
	category_name: string | null;
	opening_hours: ListarOpeningDay[];
	google_place_id: string | null;
	zip_code: string | null;
	price_range: string | null;
	social_links: Record<string, string>;
	keywords: string | null;
	video_url: string | null;
	raw: ListarPlace;
};

function socialLinks(p: ListarPlace): Record<string, string> {
	const out: Record<string, string> = {};
	const sn = p.social_network || {};
	for (const [k, v] of Object.entries(sn)) {
		if (typeof v === "string" && v.trim().startsWith("http")) out[k] = v.trim();
	}
	return out;
}

function priceRange(p: ListarPlace): string | null {
	const min = (p.price_min || "").trim();
	const max = (p.price_max || "").trim();
	if (!min && !max) return null;
	if (min && max && min !== max) return `${min}–${max}`;
	return min || max || null;
}

export function mapListarPlaceToVenue(p: ListarPlace): MappedListarVenue | null {
	const id = listarPlaceId(p);
	if (!id) return null;
	const name = stripListarHtml(p.post_title || "").trim();
	if (!name) return null;
	const slug = (p.post_name || "").trim() || slugify(name);
	const statusRaw = (p.post_status || "publish").toLowerCase();
	const status: MappedListarVenue["status"] =
		statusRaw === "publish" ? "published" : statusRaw === "draft" ? "draft" : "archived";

	return {
		external_place_id: id,
		slug,
		name,
		description: stripListarHtml(p.post_content || "") || null,
		address: p.address?.trim() || null,
		lat: listarNum(p.latitude),
		lng: listarNum(p.longitude),
		phone: p.phone?.trim() || null,
		email: listarEmail(p.email),
		website_url: typeof p.website === "string" && p.website.startsWith("http") ? p.website : null,
		listing_url: p.guid?.startsWith("http") ? p.guid : null,
		rating_avg: listarNum(p.rating_avg) ?? 0,
		rating_count: listarNum(p.rating_count) ?? 0,
		status,
		image_url: listarImageUrl(p.image),
		category_slug: p.category?.slug || null,
		category_name: p.category?.name || null,
		opening_hours: Array.isArray(p.opening_hour) ? p.opening_hour : [],
		google_place_id: p._google_place_id?.trim() || null,
		zip_code: p.zip_code?.trim() || null,
		price_range: priceRange(p),
		social_links: socialLinks(p),
		keywords: typeof p.keywords === "string" && p.keywords.trim() ? p.keywords.trim() : null,
		video_url:
			(typeof p.video_url === "string" && p.video_url) ||
			(typeof p._company_video === "string" && p._company_video) ||
			null,
		raw: p,
	};
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 80);
}

/** Full catalog of places (list pages). Enrich with place/view when needed. */
export async function fetchLakeTravisPlaces(opts?: {
	maxPages?: number;
	enrichView?: boolean;
	onProgress?: (msg: string) => void;
}): Promise<MappedListarVenue[]> {
	const origin = LAKETRAVIS_ORIGIN;
	const places = await listarAllPlaces(origin, {
		perPage: 50,
		maxPages: opts?.maxPages ?? 200,
		onPage: (page, max, n) => opts?.onProgress?.(`place/list page ${page}/${max} (+${n})`),
	});

	const mapped: MappedListarVenue[] = [];
	for (const p of places) {
		let full = p;
		if (opts?.enrichView) {
			const id = listarPlaceId(p);
			if (id) {
				try {
					const view = await listarPlaceView(origin, id);
					if (view) full = { ...p, ...view };
				} catch {
					/* keep list row */
				}
			}
		}
		const m = mapListarPlaceToVenue(full);
		if (m) mapped.push(m);
	}
	return mapped;
}

export async function fetchLakeTravisPlaceById(id: string | number): Promise<MappedListarVenue | null> {
	const view = await listarPlaceView(LAKETRAVIS_ORIGIN, id);
	return view ? mapListarPlaceToVenue(view) : null;
}

export async function fetchLakeTravisReviews(placeId: string | number) {
	const body = await listarComments(LAKETRAVIS_ORIGIN, placeId);
	const rows = (body.data || []).map((c) => ({
		source_review_id: String(c.comment_ID || ""),
		author_name: String(c.comment_author || "Anonymous").trim() || "Anonymous",
		author_url: c.comment_author_url || null,
		rating: Math.min(5, Math.max(1, Number(c.rate) || 5)),
		body: stripListarHtml(String(c.comment_content || "")),
		reviewed_at: c.comment_date_gmt
			? new Date(c.comment_date_gmt.replace(" ", "T") + "Z").toISOString()
			: c.comment_date
				? new Date(c.comment_date).toISOString()
				: new Date().toISOString(),
	}));
	return {
		rating_avg: body.attr?.rating?.rating_avg ?? null,
		rating_count: body.attr?.rating?.rating_count ?? rows.length,
		rating_meta: body.attr?.rating?.rating_meta ?? null,
		reviews: rows.filter((r) => r.source_review_id),
	};
}

// --- Events (city feed, filter by venue name) — mirrors heyaustin pattern ---

function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.replace(/['']/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function venueMatches(event: ListarEvent, venueName: string, websiteUrl?: string | null): boolean {
	const eventVenue = normalizeName(event.venue_name || "");
	const t = normalizeName(venueName);
	if (t.length >= 3 && eventVenue) {
		if (eventVenue === t) return true;
		if (eventVenue.includes(t) || t.includes(eventVenue)) return true;
		const et = new Set(eventVenue.split(" "));
		const tt = t.split(" ").filter((w) => w.length > 2);
		const overlap = tt.filter((w) => et.has(w)).length;
		if (tt.length >= 2 && overlap >= Math.min(2, tt.length)) return true;
	}
	if (websiteUrl && event.venue_website) {
		try {
			const a = new URL(websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`)
				.hostname.replace(/^www\./, "")
				.toLowerCase();
			const b = new URL(
				event.venue_website.startsWith("http")
					? event.venue_website
					: `https://${event.venue_website}`,
			)
				.hostname.replace(/^www\./, "")
				.toLowerCase();
			if (a && b && a === b) return true;
		} catch {
			/* ignore */
		}
	}
	return false;
}

function startsAtIso(raw: string | undefined): string | null {
	if (!raw) return null;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

export async function fetchLakeTravisEvents(params: {
	calendarUrl?: string;
	venueName: string;
	address: string | null;
	websiteUrl?: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxPages?: number;
}): Promise<PartnerEvent[]> {
	const origin = LAKETRAVIS_ORIGIN;
	const maxPages = params.maxPages ?? 30;
	const cutoff = Date.now() + params.scrapeDaysAhead * 864e5;
	const matched: ListarEvent[] = [];
	let maxPage = 1;

	for (let page = 1; page <= maxPages; page++) {
		const body = await listarEventList(origin, page, 70);
		if (body.pagination?.max_page) maxPage = body.pagination.max_page;
		const batch = body.data ?? [];
		if (!batch.length) break;
		for (const ev of batch) {
			if (venueMatches(ev, params.venueName, params.websiteUrl)) matched.push(ev);
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
		const title = stripListarHtml(ev.post_title || "").trim();
		if (!title) continue;
		const id = String(ev.ID ?? ev.id ?? "");
		const key = id || `${title}|${startsAt}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const image = listarImageUrl(ev.image);
		const description = ev.post_content ? stripListarHtml(ev.post_content) : null;
		const sourceUrl =
			ev.guid ||
			(ev.post_name ? `${origin}/events/${ev.post_name}/` : `${origin}/`);
		out.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: params.venueName,
				address: params.address,
				description,
				image_url: image,
				source_url: sourceUrl,
				source_partner: "laketravis_listar",
				source_event_id: id ? `laketravis-listar:${id}` : null,
				raw_date_text: ev.event_starts_sort_field || startsAt,
				ticket_url: null,
				confidence: 0.9,
			}),
		);
	}
	return out;
}

/** Yoast SEO from core WP REST for a job_listing id (public). */
export async function fetchLakeTravisWpListingSeo(wpId: string | number) {
	const jl = await listarFetchJson<{
		id: number;
		slug: string;
		link: string;
		title?: { rendered?: string };
		yoast_head_json?: {
			title?: string;
			description?: string;
			canonical?: string;
			og_title?: string;
			og_description?: string;
			og_image?: Array<{ url?: string }>;
			robots?: { index?: string; follow?: string };
		};
		meta?: Record<string, unknown>;
	}>(`${LAKETRAVIS_ORIGIN}/wp-json/wp/v2/job_listing/${wpId}`);
	const y = jl.yoast_head_json || {};
	return {
		seo_title: y.title || null,
		seo_description: y.description || null,
		canonical_url: y.canonical || jl.link || null,
		og_title: y.og_title || null,
		og_description: y.og_description || null,
		og_image_url: y.og_image?.[0]?.url || null,
		robots_index: y.robots?.index !== "noindex",
		robots_follow: y.robots?.follow !== "nofollow",
		company_website:
			typeof jl.meta?._company_website === "string" ? jl.meta._company_website : null,
	};
}
