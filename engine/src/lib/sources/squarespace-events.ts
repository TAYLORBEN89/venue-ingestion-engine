/**
 * Squarespace native Events collection (eventlist).
 *
 * HTML structure (Frontyard /upcoming-events and similar):
 *   div.eventlist.eventlist--upcoming
 *     article.eventlist-event.eventlist-event--upcoming
 *       a.eventlist-column-thumbnail          → image (data-src / data-image) + event path
 *       div.eventlist-column-date             → month/day tag
 *       h1.eventlist-title a                  → title
 *       li.eventlist-meta-date time[datetime] → YMD
 *       li.eventlist-meta-time                → wall-clock start/end (localized)
 *       div.eventlist-excerpt                 → description
 *       a.eventlist-button                    → "View Event" URL
 *
 * Also supports ?format=json ({ upcoming: EventItem[] }) as a fallback when the
 * SSR list is empty or incomplete.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { toFetchableUrl } from "./discover";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

const BROWSER_HEADERS = {
	Accept: "application/json,text/html,*/*",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface SqspLocation {
	addressTitle?: string;
	addressLine1?: string;
	addressLine2?: string;
	addressCountry?: string;
}

interface SqspEventItem {
	id?: string;
	title?: string;
	urlId?: string;
	fullUrl?: string;
	startDate?: number;
	endDate?: number;
	excerpt?: string;
	body?: string;
	assetUrl?: string;
	location?: SqspLocation;
	structuredContent?: {
		startDate?: number;
		endDate?: number;
	};
	workflowState?: string;
}

interface SqspEventsJson {
	upcoming?: SqspEventItem[];
	past?: SqspEventItem[];
	pagination?: {
		nextPage?: boolean;
		nextPageUrl?: string;
		nextPageOffset?: number;
	};
	collection?: {
		id?: string;
		type?: number;
		title?: string;
		fullUrl?: string;
	};
}

export function isSquarespaceEventsCalendar(html: string, pageUrl: string): boolean {
	const hay = `${pageUrl}\n${html}`;
	// Known Squarespace Events venues
	if (/frontyardbrewing\.com/i.test(pageUrl)) return true;
	if (/vistabrewingtx\.com/i.test(pageUrl)) return true;
	if (
		/eventlist-event/i.test(html) &&
		/squarespace|static\.sqspcdn|static1\.squarespace/i.test(hay)
	) {
		return true;
	}
	if (
		/static\.SQUARESPACE_CONTEXT|squarespace/i.test(html) &&
		(/"type"\s*:\s*1\b/.test(html) || /eventlist-title/i.test(html)) &&
		/upcoming-events|\/calendars(?:\/|$|\?)|\/events(?:-\d+)?(?:\/|$|\?)/i.test(pageUrl)
	) {
		return true;
	}
	return false;
}

function stripTags(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/\u202f/g, " ") // narrow no-break space (Squarespace times)
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url.replace(/\/$/, "");
	}
}

function absUrl(origin: string, pathOrUrl: string | null | undefined): string | null {
	if (!pathOrUrl) return null;
	if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
	return `${origin}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function jsonUrl(calendarUrl: string, offset?: number | string): string {
	const u = new URL(toFetchableUrl(calendarUrl));
	u.searchParams.set("format", "json");
	if (offset != null && offset !== "") {
		u.searchParams.set("offset", String(offset));
	}
	return u.toString();
}

async function fetchJson(url: string): Promise<SqspEventsJson> {
	const res = await fetch(toFetchableUrl(url), { headers: BROWSER_HEADERS });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} fetching Squarespace events JSON ${url}`);
	}
	const ct = res.headers.get("content-type") || "";
	const text = await res.text();
	if (!ct.includes("json") && !text.trimStart().startsWith("{")) {
		throw new Error(`Expected JSON from ${url}, got ${ct || "unknown"} (${text.length} bytes)`);
	}
	return JSON.parse(text) as SqspEventsJson;
}

function itemAddress(item: SqspEventItem, fallback: string | null): string | null {
	const loc = item.location;
	if (!loc) return fallback;
	const parts = [loc.addressLine1, loc.addressLine2].filter(Boolean);
	if (parts.length) return parts.join(", ");
	if (loc.addressTitle) return loc.addressTitle;
	return fallback;
}

function itemDescription(item: SqspEventItem): string | null {
	const excerpt = item.excerpt ? stripTags(item.excerpt) : "";
	if (excerpt.length >= 40) return excerpt.slice(0, 4000);
	const body = item.body ? stripTags(item.body) : "";
	if (body.length >= 20) return body.slice(0, 4000);
	return excerpt || body || null;
}

function extractTicketUrlFromHtml(hay: string, baseUrl: string): string | null {
	const m =
		hay.match(
			/href=["'](https?:\/\/(?:www\.)?(?:eventbrite|etix|dice\.fm|ticketmaster|prekindle|seetickets)[^"']+)["']/i,
		) ||
		hay.match(/href=["'](https?:\/\/[^"']*(?:ticket|tickets|rsvp|register)[^"']*)["']/i);
	if (!m?.[1]) return null;
	try {
		return new URL(m[1], baseUrl).toString();
	} catch {
		return m[1];
	}
}

function toIso(ms: number | undefined): string | null {
	if (ms == null || !Number.isFinite(ms)) return null;
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

/** Parse "4:00 PM" / "4:00PM" / "16:00" → HH:mm:ss */
function parseClock(text: string): string | null {
	const cleaned = text.replace(/\u202f/g, " ").trim();
	const ampm = cleaned.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
	if (ampm) {
		let h = Number(ampm[1]);
		const m = Number(ampm[2]);
		const ap = ampm[3].toUpperCase();
		if (ap === "PM" && h < 12) h += 12;
		if (ap === "AM" && h === 12) h = 0;
		return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
	}
	const h24 = cleaned.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
	if (h24) {
		return `${String(Number(h24[1])).padStart(2, "0")}:${h24[2]}:00`;
	}
	return null;
}

function extractArticleChunks(html: string): string[] {
	// Prefer the upcoming list container when present
	const listMatch = html.match(
		/<div\b[^>]*class="[^"]*\beventlist\b[^"]*\beventlist--upcoming\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*class="[^"]*\beventlist\b[^"]*\beventlist--past\b|\s*<\/div>\s*<div\b[^>]*class="[^"]*eventlist-pagination|\s*$)/i,
	);
	const scope = listMatch?.[1] ?? html;

	const re = /<article\b[^>]*class="[^"]*\beventlist-event\b[^"]*"[^>]*>/gi;
	const starts: number[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(scope)) !== null) starts.push(m.index);

	const chunks: string[] = [];
	for (let i = 0; i < starts.length; i++) {
		const start = starts[i];
		const end = i + 1 < starts.length ? starts[i + 1] : Math.min(scope.length, start + 20_000);
		const chunk = scope.slice(start, end);
		// Skip past-only cards when class is explicit
		if (/eventlist-event--past/i.test(chunk) && !/eventlist-event--upcoming/i.test(chunk)) {
			continue;
		}
		chunks.push(chunk);
	}
	return chunks;
}

/**
 * Parse SSR eventlist HTML (user-documented Frontyard structure).
 */
export function parseSquarespaceEventListHtml(params: {
	html: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
	pastGraceHours?: number;
}): PartnerEvent[] {
	const {
		html,
		calendarUrl,
		venueName,
		address = null,
		timezone = "America/Chicago",
		scrapeDaysAhead = 120,
		pastGraceHours = 12,
	} = params;

	const origin = originOf(calendarUrl);
	const now = Date.now();
	const cutoff = now + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const pastFloor = now - pastGraceHours * 60 * 60 * 1000;
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const chunk of extractArticleChunks(html)) {
		// Title: h1.eventlist-title (link text preferred)
		const titleHtml =
			chunk.match(
				/<h1\b[^>]*class="[^"]*\beventlist-title\b[^"]*"[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i,
			)?.[1] ??
			chunk.match(/<h1\b[^>]*class="[^"]*\beventlist-title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
			"";
		const title = stripTags(titleHtml).replace(/\s+/g, " ").trim();
		if (!title || title.length < 2) continue;

		// URL: View Event button, else thumbnail, else title link
		// Attribute order varies: href may come before or after class.
		const path =
			chunk.match(
				/<a\b[^>]*\beventlist-button\b[^>]*\bhref=["']([^"']+)["']/i,
			)?.[1] ??
			chunk.match(
				/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\beventlist-button\b/i,
			)?.[1] ??
			chunk.match(
				/<a\b[^>]*\beventlist-column-thumbnail\b[^>]*\bhref=["']([^"']+)["']/i,
			)?.[1] ??
			chunk.match(
				/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\beventlist-column-thumbnail\b/i,
			)?.[1] ??
			chunk.match(
				/<a\b[^>]*\beventlist-title-link\b[^>]*\bhref=["']([^"']+)["']/i,
			)?.[1] ??
			chunk.match(
				/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\beventlist-title-link\b/i,
			)?.[1] ??
			chunk.match(/href=["'](\/upcoming-events\/[^"'?#]+)["']/i)?.[1] ??
			chunk.match(/href=["'](\/calendars\/[^"'?#]+)["']/i)?.[1] ??
			null;
		const sourceUrl = absUrl(origin, path) || calendarUrl;

		// Image: list thumbnail (a.eventlist-column-thumbnail content-fill).
		// Prefer data-image / data-src (full CDN asset); strip tiny format params later if needed.
		// Detail pages often expose the same asset via JSON-LD Event.image ?format=1500w.
		let imageUrl =
			chunk.match(
				/eventlist-column-thumbnail[\s\S]{0,2500}?data-image=["'](https?:\/\/[^"']+)["']/i,
			)?.[1] ??
			chunk.match(
				/eventlist-column-thumbnail[\s\S]{0,2500}?data-src=["'](https?:\/\/[^"']+)["']/i,
			)?.[1] ??
			chunk.match(
				/eventlist-column-thumbnail[\s\S]{0,2500}?src=["'](https:\/\/images\.squarespace-cdn\.com[^"']+)["']/i,
			)?.[1] ??
			chunk.match(/data-src=["'](https:\/\/images\.squarespace-cdn\.com[^"']+)["']/i)?.[1] ??
			null;
		// Prefer a larger Squarespace derivative when the list only ships a tiny srcset pick
		if (imageUrl && /images\.squarespace-cdn\.com/i.test(imageUrl) && !/[?&]format=/i.test(imageUrl)) {
			imageUrl = `${imageUrl}${imageUrl.includes("?") ? "&" : "?"}format=1500w`;
		}

		// Date: time.event-date[datetime="YYYY-MM-DD"]
		const ymd =
			chunk.match(
				/eventlist-meta-date[\s\S]{0,400}?<time\b[^>]*datetime=["'](\d{4}-\d{2}-\d{2})["']/i,
			)?.[1] ??
			chunk.match(/<time\b[^>]*class="[^"]*\bevent-date\b[^"]*"[^>]*datetime=["'](\d{4}-\d{2}-\d{2})["']/i)?.[1] ??
			chunk.match(/datetime=["'](\d{4}-\d{2}-\d{2})["']/i)?.[1] ??
			null;
		if (!ymd) continue;

		// Time: eventlist-meta-time → start/end localized times
		const timeBlock =
			chunk.match(
				/<li\b[^>]*class="[^"]*\beventlist-meta-time\b[^"]*"[^>]*>([\s\S]*?)<\/li>/i,
			)?.[1] ?? "";
		const startClockText =
			timeBlock.match(
				/<time\b[^>]*class="[^"]*\bevent-time-localized-start\b[^"]*"[^>]*>([\s\S]*?)<\/time>/i,
			)?.[1] ??
			timeBlock.match(/event-time-localized-start[^>]*>([\s\S]*?)<\/time>/i)?.[1] ??
			stripTags(timeBlock);
		const endClockText =
			timeBlock.match(
				/<time\b[^>]*class="[^"]*\bevent-time-localized-end\b[^"]*"[^>]*>([\s\S]*?)<\/time>/i,
			)?.[1] ?? null;

		const startClock = parseClock(stripTags(startClockText)) || "19:00:00";
		const endClock = endClockText ? parseClock(stripTags(endClockText)) : null;

		let startsAt: string;
		let endsAt: string | null = null;
		try {
			startsAt = localWallTimeToUtcIso(`${ymd} ${startClock}`, timezone);
			if (endClock) {
				endsAt = localWallTimeToUtcIso(`${ymd} ${endClock}`, timezone);
				// Overnight end (end < start) → next day
				if (endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
					const next = new Date(`${ymd}T12:00:00Z`);
					next.setUTCDate(next.getUTCDate() + 1);
					const nextYmd = next.toISOString().slice(0, 10);
					endsAt = localWallTimeToUtcIso(`${nextYmd} ${endClock}`, timezone);
				}
			}
		} catch {
			continue;
		}

		const startMs = new Date(startsAt).getTime();
		if (Number.isNaN(startMs)) continue;
		if (startMs < pastFloor) continue;
		if (startMs > cutoff) continue;

		// Description: div.eventlist-excerpt
		const excerptHtml =
			chunk.match(
				/<div\b[^>]*class="[^"]*\beventlist-excerpt\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
			)?.[1] ?? "";
		const description = excerptHtml ? stripTags(excerptHtml).slice(0, 4000) : null;

		const ticketUrl = extractTicketUrlFromHtml(chunk, origin);
		const sourceEventId = path
			? `sqsp-eventlist:${path.replace(/^https?:\/\/[^/]+/i, "").replace(/\/$/, "")}`
			: `sqsp-eventlist:${title.toLowerCase()}|${ymd}|${startClock}`;

		const dedupe = `${title.toLowerCase()}|${startsAt}`;
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);

		const rawDateText = stripTags(
			[
				chunk.match(
					/<time\b[^>]*class="[^"]*\bevent-date\b[^"]*"[^>]*>([\s\S]*?)<\/time>/i,
				)?.[1] ?? ymd,
				stripTags(startClockText),
				endClockText ? stripTags(endClockText) : "",
			]
				.filter(Boolean)
				.join(" "),
		);

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: endsAt,
				venue_name: venueName,
				address,
				description,
				image_url: imageUrl,
				source_url: sourceUrl,
				source_partner: "squarespace_events",
				source_event_id: sourceEventId,
				raw_date_text: rawDateText || startsAt,
				ticket_url: ticketUrl,
				confidence: 0.94,
			}),
		);
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

export function parseSquarespaceEventsJson(params: {
	data: SqspEventsJson;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	scrapeDaysAhead?: number;
	pastGraceHours?: number;
}): PartnerEvent[] {
	const {
		data,
		calendarUrl,
		venueName,
		address = null,
		scrapeDaysAhead = 120,
		pastGraceHours = 12,
	} = params;

	const origin = originOf(calendarUrl);
	const now = Date.now();
	const cutoff = now + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const pastFloor = now - pastGraceHours * 60 * 60 * 1000;
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	const items = [...(data.upcoming ?? [])];
	for (const p of data.past ?? []) {
		const start = p.startDate ?? p.structuredContent?.startDate;
		if (start != null && start >= pastFloor) items.push(p);
	}

	for (const item of items) {
		const title = (item.title ?? "").replace(/\s+/g, " ").trim();
		if (!title || title.length < 2) continue;

		const startMs = item.startDate ?? item.structuredContent?.startDate;
		const endMs = item.endDate ?? item.structuredContent?.endDate;
		const startsAt = toIso(startMs);
		if (!startsAt || startMs == null) continue;
		if (startMs < pastFloor) continue;
		if (startMs > cutoff) continue;

		const path =
			item.fullUrl ||
			(item.urlId
				? /\/calendars/i.test(calendarUrl)
					? `/calendars/${item.urlId}`
					: `/upcoming-events/${item.urlId}`
				: null);
		const sourceUrl = absUrl(origin, path) || calendarUrl;
		const endsAt = toIso(endMs);
		const imageUrl = item.assetUrl?.startsWith("http") ? item.assetUrl : null;
		const ticketUrl = extractTicketUrlFromHtml(
			`${item.excerpt ?? ""}\n${item.body ?? ""}`,
			origin,
		);
		const sourceEventId = item.id
			? `sqsp-event:${item.id}`
			: `sqsp-event:${title.toLowerCase()}|${startsAt}`;

		const dedupe = `${title.toLowerCase()}|${startsAt}`;
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: endsAt,
				venue_name: venueName,
				address: itemAddress(item, address),
				description: itemDescription(item),
				image_url: imageUrl,
				source_url: sourceUrl,
				source_partner: "squarespace_events",
				source_event_id: sourceEventId,
				raw_date_text: startsAt,
				ticket_url: ticketUrl,
				confidence: 0.93,
			}),
		);
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

async function fetchSquarespaceEventsJson(params: {
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	scrapeDaysAhead?: number;
	maxPages?: number;
}): Promise<PartnerEvent[]> {
	const {
		calendarUrl,
		venueName,
		address = null,
		scrapeDaysAhead = 120,
		maxPages = 4,
	} = params;

	const all: PartnerEvent[] = [];
	const seenIds = new Set<string>();
	let nextUrl: string | null = jsonUrl(calendarUrl);
	let pages = 0;

	while (nextUrl && pages < maxPages) {
		pages += 1;
		const data = await fetchJson(nextUrl);
		const batch = parseSquarespaceEventsJson({
			data,
			calendarUrl,
			venueName,
			address,
			scrapeDaysAhead,
		});
		for (const e of batch) {
			const key = e.source_event_id || `${e.title}|${e.starts_at}`;
			if (seenIds.has(key)) continue;
			seenIds.add(key);
			all.push(e);
		}

		const upcomingCount = data.upcoming?.length ?? 0;
		if (upcomingCount === 0) break;
		if (!data.pagination?.nextPage || !data.pagination.nextPageUrl) break;

		const origin = originOf(calendarUrl);
		const rel = data.pagination.nextPageUrl;
		const absolute = absUrl(origin, rel)!;
		const u = new URL(absolute);
		u.searchParams.set("format", "json");
		nextUrl = u.toString();
	}

	all.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return all;
}

/**
 * Fetch Frontyard-style Squarespace events.
 * 1) Parse SSR eventlist HTML (primary — matches the live DOM walkthrough)
 * 2) Fall back to ?format=json if HTML yields nothing
 */
export async function fetchSquarespaceEvents(params: {
	calendarHtml?: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
	maxPages?: number;
}): Promise<PartnerEvent[]> {
	const {
		calendarUrl,
		venueName,
		address = null,
		timezone = "America/Chicago",
		scrapeDaysAhead = 120,
		maxPages = 4,
	} = params;

	let html = params.calendarHtml ?? "";
	if (!html || !/eventlist-event/i.test(html)) {
		try {
			html = await fetchPageText(calendarUrl);
		} catch {
			/* JSON fallback below */
		}
	}

	if (html && /eventlist-event/i.test(html)) {
		const fromHtml = parseSquarespaceEventListHtml({
			html,
			calendarUrl,
			venueName,
			address,
			timezone,
			scrapeDaysAhead,
		});
		if (fromHtml.length > 0) return fromHtml;
	}

	return fetchSquarespaceEventsJson({
		calendarUrl,
		venueName,
		address,
		scrapeDaysAhead,
		maxPages,
	});
}

export async function fetchSquarespaceEventsFromHtml(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
}): Promise<PartnerEvent[]> {
	return fetchSquarespaceEvents(params);
}
