/**
 * Doc's Drive-In Theatre (docsdriveintheatre.com)
 *
 * Walkthrough (admin pilot):
 * 1. Calendar: https://www.docsdriveintheatre.com/events/event-calendar
 *    FullCalendar v2 grid (#calendar-*, .fc-day-grid)
 *    Month nav: .fc-icon-right-single-arrow / prev
 *    Day cells: a.fc-day-grid-event → /event/detail/{id}
 * 2. Detail: https://www.docsdriveintheatre.com/event/detail/{id}
 *    Poster: img.img-fluid (TMDB), h1.movie-title, .text-muted showtime,
 *    About the Movie, pricing ul.list-unstyled
 *
 * Structured feed (preferred — no browser):
 *   GET https://www.docsdriveintheatre.com/api/events
 *   → { data: [{ id, title, start_date, end_date, extras:[{key_name,key_value}], prices… }] }
 *   extras include tmdb_img, overview, director, genres, movie_duration
 *
 * Calendar HTML also embeds FullCalendar `events:[{title,start,url}]` as fallback.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

const ORIGIN = "https://www.docsdriveintheatre.com";
const API_EVENTS = `${ORIGIN}/api/events`;
const CALENDAR_PATH = "/events/event-calendar";

export type DocsDriveInExtra = {
	key_name?: string;
	key_value?: string | number | null;
};

export type DocsDriveInApiEvent = {
	id?: number | string | null;
	title?: string | null;
	description?: string | null;
	event_slug?: string | null;
	event_image?: string | null;
	ext_book_url?: string | null;
	movies?: string | number | null;
	start_date?: string | null;
	end_date?: string | null;
	sold_out?: number | boolean | null;
	special_info?: string | null;
	per_slot_price?: string | number | null;
	adult_price?: string | number | null;
	child_price?: string | number | null;
	convenience_price?: string | number | null;
	tax_price?: string | number | null;
	extras?: DocsDriveInExtra[] | null;
};

function decodeEntities(s: string): string {
	let t = s;
	for (let i = 0; i < 3; i++) {
		const next = t
			.replace(/&amp;/gi, "&")
			.replace(/&#0*36;|&#36;/g, "$")
			.replace(/&#0*39;|&apos;/gi, "'")
			.replace(/&#8217;|&rsquo;/gi, "'")
			.replace(/&quot;/gi, '"')
			.replace(/&nbsp;/gi, " ")
			.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
		if (next === t) break;
		t = next;
	}
	return t.replace(/\s+/g, " ").trim();
}

function stripHtml(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export function isDocsDriveIn(pageUrl: string, html = ""): boolean {
	if (/docsdriveintheatre\.com/i.test(pageUrl)) return true;
	return (
		/docsdriveintheatre\.com/i.test(html) &&
		(/fullCalendar\s*\(|fc-day-grid-event|id=["']calendar-\d+["']/i.test(html) ||
			/movie-title|event\/detail\//i.test(html))
	);
}

function extrasMap(extras: DocsDriveInExtra[] | null | undefined): Map<string, string> {
	const m = new Map<string, string>();
	for (const row of extras ?? []) {
		const k = String(row.key_name || "").trim();
		if (!k) continue;
		const v = row.key_value;
		if (v === null || v === undefined || v === "") continue;
		m.set(k, decodeEntities(String(v)));
	}
	return m;
}

function httpsify(url: string | null | undefined): string | null {
	if (!url) return null;
	const u = url.trim();
	if (!u || /upload\.png$/i.test(u)) return null;
	if (u.startsWith("//")) return `https:${u}`;
	if (u.startsWith("http://")) return `https://${u.slice("http://".length)}`;
	if (u.startsWith("/")) return `${ORIGIN}${u}`;
	return u;
}

/**
 * Parse "2026/07/26 20:45" or "2026-07-26 20:45:00" wall clock → UTC ISO.
 */
export function parseDocsLocalDate(raw: string, timezone: string): string | null {
	const s = raw.trim().replace(/\//g, "-");
	const m = s.match(
		/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
	);
	if (!m) return null;
	const y = m[1]!;
	const mo = String(Number(m[2])).padStart(2, "0");
	const d = String(Number(m[3])).padStart(2, "0");
	const hh = String(Number(m[4] ?? "0")).padStart(2, "0");
	const mm = String(Number(m[5] ?? "0")).padStart(2, "0");
	const ss = String(Number(m[6] ?? "0")).padStart(2, "0");
	try {
		return localWallTimeToUtcIso(`${y}-${mo}-${d} ${hh}:${mm}:${ss}`, timezone);
	} catch {
		return null;
	}
}

function formatPriceText(ev: DocsDriveInApiEvent): string | null {
	const parts: string[] = [];
	const car = ev.per_slot_price != null && String(ev.per_slot_price) !== "" ? String(ev.per_slot_price) : null;
	const adult = ev.adult_price != null && String(ev.adult_price) !== "" ? String(ev.adult_price) : null;
	const child = ev.child_price != null && String(ev.child_price) !== "" ? String(ev.child_price) : null;
	if (car) parts.push(`$${car} car spot`);
	if (adult) parts.push(`$${adult} adult`);
	if (child) parts.push(`$${child} child`);
	if (!parts.length) return null;
	const fee =
		ev.convenience_price != null && String(ev.convenience_price) !== ""
			? ` + $${ev.convenience_price} fee`
			: "";
	return parts.join(" / ") + fee;
}

function buildDescription(title: string, ex: Map<string, string>, special: string | null): string | null {
	const chunks: string[] = [];
	const overview = ex.get("overview");
	if (overview) chunks.push(overview);
	const director = ex.get("director");
	const runtime = ex.get("movie_duration");
	const genres = ex.get("genres");
	const meta: string[] = [];
	if (director) meta.push(`Director: ${director}`);
	if (runtime) meta.push(`Runtime: ${runtime} min`);
	if (genres) meta.push(`Genres: ${genres}`);
	if (meta.length) chunks.push(meta.join(" · "));
	if (special?.trim()) chunks.push(special.trim());
	if (!chunks.length) return null;
	return chunks.join("\n\n").slice(0, 4000);
}

function detailUrl(id: number | string): string {
	return `${ORIGIN}/event/detail/${id}`;
}

export function partnerEventFromDocsApi(
	ev: DocsDriveInApiEvent,
	params: { venueName: string; address: string | null; timezone: string },
): PartnerEvent | null {
	const title = decodeEntities(String(ev.title || "").trim());
	if (!title || title.length < 2) return null;
	if (!ev.start_date) return null;
	const startsAt = parseDocsLocalDate(String(ev.start_date), params.timezone);
	if (!startsAt) return null;

	let endsAt: string | null = null;
	if (ev.end_date) {
		const e = parseDocsLocalDate(String(ev.end_date), params.timezone);
		if (e && Date.parse(e) > Date.parse(startsAt)) endsAt = e;
	}

	const ex = extrasMap(ev.extras);
	const imageUrl =
		httpsify(ex.get("tmdb_img")) ||
		httpsify(ex.get("uploaded_img")) ||
		httpsify(ev.event_image);

	const id = ev.id != null && String(ev.id) !== "" ? String(ev.id) : null;
	const sourceUrl = id ? detailUrl(id) : `${ORIGIN}${CALENDAR_PATH}`;
	const ticketUrl =
		(ev.ext_book_url && String(ev.ext_book_url).startsWith("http")
			? String(ev.ext_book_url)
			: null) || sourceUrl;

	// Note: API often sets sold_out=1 for all rows (not reliable sold-out flag).
	// Prefer special_info / seat_count later if we confirm semantics.
	const priceText = formatPriceText(ev);

	const description = buildDescription(title, ex, ev.special_info ? String(ev.special_info) : null);

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		ends_at: endsAt,
		venue_name: params.venueName,
		address: params.address,
		description,
		image_url: imageUrl,
		source_url: sourceUrl,
		source_partner: "docs_drive_in",
		source_event_id: id ? `docs-drive-in:${id}` : `docs-drive-in:${title}|${startsAt}`,
		raw_date_text: String(ev.start_date),
		price_text: priceText,
		ticket_url: ticketUrl,
		confidence: 1,
	});
}

/** Fallback: FullCalendar events array embedded in calendar page JS. */
export function parseDocsDriveInEmbeddedCalendar(
	html: string,
	params: { venueName: string; address: string | null; timezone: string; pageUrl: string },
): PartnerEvent[] {
	const out: PartnerEvent[] = [];
	const seen = new Set<string>();

	// fullCalendar({"events":[...]}  — capture the events array
	const eventsMatch = html.match(/"events"\s*:\s*(\[[\s\S]*?\])\s*[,}]\s*"(?:eventLimit|header|timezone|defaultDate)/i)
		|| html.match(/\.fullCalendar\(\{[\s\S]*?"events"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
	if (!eventsMatch?.[1]) return out;

	let list: unknown[];
	try {
		list = JSON.parse(eventsMatch[1]) as unknown[];
	} catch {
		return out;
	}

	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const e = raw as { title?: string; start?: string; end?: string; url?: string; id?: string | number };
		const title = decodeEntities(String(e.title || "").trim());
		if (!title) continue;
		const startRaw = e.start;
		if (!startRaw) continue;

		// FullCalendar may emit ISO with offset already
		let startsAt: string | null = null;
		if (/^\d{4}-\d{2}-\d{2}T/.test(startRaw) && (startRaw.includes("+") || /Z$/i.test(startRaw))) {
			const t = Date.parse(startRaw);
			if (!Number.isNaN(t)) startsAt = new Date(t).toISOString();
		} else {
			startsAt = parseDocsLocalDate(startRaw.replace("T", " ").slice(0, 19), params.timezone);
		}
		if (!startsAt) continue;

		const url = e.url ? decodeEntities(String(e.url).replace(/\\\//g, "/")) : null;
		// Prefer own detail pages; keep Eventbrite cross-promos if on this calendar
		const sourceUrl = url || params.pageUrl;
		const idFromUrl = sourceUrl.match(/\/event\/detail\/(\d+)/i)?.[1] ?? null;
		const key = `${title.toLowerCase()}|${startsAt}`;
		if (seen.has(key)) continue;
		seen.add(key);

		out.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: params.venueName,
				address: params.address,
				description: null,
				image_url: null,
				source_url: sourceUrl,
				source_partner: "docs_drive_in",
				source_event_id: idFromUrl
					? `docs-drive-in:${idFromUrl}`
					: `docs-drive-in:${title}|${startsAt}`,
				raw_date_text: startRaw,
				ticket_url: sourceUrl,
				confidence: 0.85,
			}),
		);
	}
	return out;
}

/**
 * Enrich a thin embedded event from the detail page (poster + about + pricing).
 * Optional — API path already has extras.
 */
export function parseDocsDriveInDetailHtml(
	html: string,
	pageUrl: string,
): {
	title: string | null;
	imageUrl: string | null;
	whenText: string | null;
	description: string | null;
	priceText: string | null;
} {
	const title =
		stripHtml(html.match(/class=["']movie-title["'][^>]*>([\s\S]*?)<\//i)?.[1] || "") || null;
	const imageUrl = httpsify(
		html.match(/image\.tmdb\.org[^"'\s>]+/i)?.[0] ||
			html.match(/class=["'][^"']*img-fluid[^"']*["'][^>]*src=["']([^"']+)/i)?.[1] ||
			html.match(/src=["'](https?:\/\/image\.tmdb\.org[^"']+)/i)?.[1],
	);
	const whenText =
		stripHtml(html.match(/class=["']text-muted["'][^>]*>([\s\S]*?)<\//i)?.[1] || "") || null;

	let description: string | null = null;
	const aboutBlock = html.match(
		/About the Movie[\s\S]{0,80}?(?:<\/h3>|<h3)([\s\S]{20,2500}?)(?:<h3|<\/div>\s*<div class=["']col)/i,
	)?.[1];
	if (aboutBlock) {
		const p = aboutBlock.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || aboutBlock;
		const t = stripHtml(p);
		if (t.length > 40) description = t.slice(0, 4000);
	}

	let priceText: string | null = null;
	const ul = html.match(/class=["']list-unstyled["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1];
	if (ul) {
		const items = [...ul.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
			.map((m) => stripHtml(m[1]!))
			.filter((t) => t.length > 3 && /\$|ticket|adult|child|fee|car/i.test(t));
		if (items.length) priceText = items.slice(0, 5).join("; ").slice(0, 300);
	}

	return { title, imageUrl, whenText, description, priceText };
}

export async function fetchDocsDriveInEvents(params: {
	calendarHtml?: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	maxEvents?: number;
	/** Fetch detail pages only when API image/description missing (default false — API is rich). */
	enrichFromDetail?: boolean;
}): Promise<PartnerEvent[]> {
	const timezone = params.timezone || "America/Chicago";
	const days = params.scrapeDaysAhead ?? 120;
	const maxEvents = params.maxEvents ?? 80;
	const now = Date.now() - 2 * 60 * 60 * 1000;
	const cutoff = Date.now() + days * 24 * 60 * 60 * 1000;

	const out: PartnerEvent[] = [];
	const seen = new Set<string>();

	// 1) Preferred: JSON API
	try {
		const raw = await fetchPageText(API_EVENTS);
		const parsed = JSON.parse(raw) as { data?: DocsDriveInApiEvent[] } | DocsDriveInApiEvent[];
		const list = Array.isArray(parsed) ? parsed : parsed.data ?? [];
		for (const row of list) {
			const ev = partnerEventFromDocsApi(row, {
				venueName: params.venueName,
				address: params.address,
				timezone,
			});
			if (!ev) continue;
			const t = Date.parse(ev.starts_at);
			if (Number.isNaN(t) || t < now || t > cutoff) continue;
			const key = ev.source_event_id || `${ev.title}|${ev.starts_at}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(ev);
			if (out.length >= maxEvents) break;
		}
	} catch {
		// fall through to embedded calendar
	}

	// 2) Fallback: FullCalendar events embedded on calendar HTML
	if (out.length === 0) {
		let html = params.calendarHtml;
		if (!html) {
			try {
				html = await fetchPageText(params.calendarUrl);
			} catch {
				html = "";
			}
		}
		if (html) {
			for (const ev of parseDocsDriveInEmbeddedCalendar(html, {
				venueName: params.venueName,
				address: params.address,
				timezone,
				pageUrl: params.calendarUrl,
			})) {
				const t = Date.parse(ev.starts_at);
				if (Number.isNaN(t) || t < now || t > cutoff) continue;
				const key = ev.source_event_id || `${ev.title}|${ev.starts_at}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(ev);
				if (out.length >= maxEvents) break;
			}
		}
	}

	// 3) Optional detail enrichment for thin rows
	if (params.enrichFromDetail) {
		for (let i = 0; i < out.length; i++) {
			const ev = out[i]!;
			if (ev.image_url && ev.description) continue;
			const detail = ev.source_url?.match(/\/event\/detail\/\d+/i)?.[0]
				? ev.source_url
				: null;
			if (!detail) continue;
			try {
				const html = await fetchPageText(detail);
				const d = parseDocsDriveInDetailHtml(html, detail);
				out[i] = {
					...ev,
					title: d.title || ev.title,
					image_url: ev.image_url || d.imageUrl,
					description: ev.description || d.description,
					price_text: ev.price_text || d.priceText,
				};
			} catch {
				// keep thin row
			}
		}
	}

	out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return out;
}
