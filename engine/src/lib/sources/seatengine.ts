import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";
import { fetchWixVelvShowMedia } from "./wix-velv-media";

export function isSeatEngineCalendar(html: string, pageUrl: string): boolean {
	return (
		/seatengine\.com/i.test(pageUrl) ||
		/cdn\.seatengine\.com/i.test(html) ||
		/files\.seatengine\.com/i.test(html) ||
		/id=["']se-calendar["']/i.test(html) ||
		/capcitycomedy\.com/i.test(pageUrl)
	);
}

/** Cap City / helium-style: calendar grid links to /events/{id}, not only /shows/{id}. */
export function isSeatEngineEventGrid(html: string, pageUrl: string): boolean {
	const hasSeCal = /id=["']se-calendar["']/i.test(html) || /cdn\.seatengine\.com/i.test(html);
	const hasEventLinks = /\/events\/\d+/i.test(html);
	const isCapCity = /capcitycomedy\.com/i.test(pageUrl);
	return isCapCity || (hasSeCal && hasEventLinks);
}

export function extractSeatEngineShowIds(html: string): string[] {
	return [...new Set([...html.matchAll(/\/shows\/(\d+)/gi)].map((m) => m[1]!))];
}

export function extractSeatEngineEventIds(html: string): string[] {
	return [...new Set([...html.matchAll(/\/events\/(\d+)/gi)].map((m) => m[1]!))];
}

/**
 * Pull event ids with calendar cell dates from a single month grid page.
 * Used to walk furthest → nearest and stop at known inventory.
 */
export function extractSeatEngineEventEntries(
	html: string,
	month: number,
	year: number,
): { eventId: string; day: number; month: number; year: number; sortKey: number }[] {
	const out: { eventId: string; day: number; month: number; year: number; sortKey: number }[] = [];
	// SeatEngine day cells: <span class='date'>N</span> … /events/ID
	for (const cell of html.matchAll(
		/<span\s+class=['"]date['"]\s*>\s*(\d{1,2})\s*<\/span>([\s\S]*?)(?=<span\s+class=['"]date['"]|<\/tr>|$)/gi,
	)) {
		const day = Number(cell[1]);
		const body = cell[2] ?? "";
		if (!Number.isFinite(day) || day < 1 || day > 31) continue;
		const sortKey = Date.UTC(year, month - 1, day);
		for (const m of body.matchAll(/\/events\/(\d+)/gi)) {
			out.push({ eventId: m[1]!, day, month, year, sortKey });
		}
	}
	// Fallback: any /events/ links without a parseable cell still count (sort to month mid)
	if (out.length === 0) {
		const mid = Date.UTC(year, month - 1, 15);
		for (const m of html.matchAll(/\/events\/(\d+)/gi)) {
			out.push({ eventId: m[1]!, day: 15, month, year, sortKey: mid });
		}
	}
	return out;
}

/** Extract SeatEngine event id from source_event_id / source_url shapes. */
export function parseSeatEngineEventIdFromSource(raw: string | null | undefined): string | null {
	if (!raw) return null;
	// Strict: only explicit SeatEngine listing shapes (no loose digit fallback — poisons known-set)
	const m = raw.match(/seatengine:event:(\d+)/i) ?? raw.match(/\/events\/(\d+)/i);
	return m?.[1] ?? null;
}

/**
 * Unique event ids ordered by calendar day.
 * direction "nearest" = soonest first (best for pilots); "furthest" = farthest first.
 * When the same listing spans multiple days, use min day for nearest / max for furthest.
 */
export function orderSeatEngineEventIdsByDate(
	entries: { eventId: string; sortKey: number }[],
	direction: "nearest" | "furthest" = "nearest",
): string[] {
	const byId = new Map<string, number>();
	for (const e of entries) {
		const prev = byId.get(e.eventId);
		if (prev === undefined) {
			byId.set(e.eventId, e.sortKey);
			continue;
		}
		if (direction === "furthest" ? e.sortKey > prev : e.sortKey < prev) {
			byId.set(e.eventId, e.sortKey);
		}
	}
	const rows = [...byId.entries()];
	rows.sort((a, b) =>
		direction === "furthest"
			? b[1] - a[1] || Number(b[0]) - Number(a[0])
			: a[1] - b[1] || Number(a[0]) - Number(b[0]),
	);
	return rows.map(([id]) => id);
}

/** @deprecated use orderSeatEngineEventIdsByDate */
export function orderSeatEngineEventIdsFurthestFirst(
	entries: { eventId: string; sortKey: number }[],
): string[] {
	return orderSeatEngineEventIdsByDate(entries, "furthest");
}

/** Prefer artist headshots over venue logos/header images that appear first in SeatEngine HTML. */
export function extractSeatEngineTalentImage(html: string): string | null {
	const headshot =
		html.match(/https:\/\/files\.seatengine\.com\/talent\/headshots\/[^"'\s<>]+/i)?.[0] ?? null;
	if (headshot) return headshot;

	const ogImage =
		html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
	if (ogImage && /talent\/headshots/i.test(ogImage)) return ogImage;

	for (const match of html.matchAll(
		/https:\/\/files\.seatengine\.com\/(?!styles\/(?:logos|header_images))[^"'\s<>]+/gi,
	)) {
		return match[0];
	}
	return null;
}

/** Map each show id to the talent headshot in its calendar listing block. */
export function buildShowImageMapFromCalendar(calendarHtml: string): Map<string, string> {
	const map = new Map<string, string>();
	const sections = calendarHtml.split(/(?=https:\/\/files\.seatengine\.com\/talent\/headshots)/i);
	for (const section of sections) {
		const imageUrl = section.match(
			/https:\/\/files\.seatengine\.com\/talent\/headshots\/[^"'\s<>]+/i,
		)?.[0];
		if (!imageUrl) continue;
		for (const showMatch of section.matchAll(/\/shows\/(\d+)/gi)) {
			map.set(showMatch[1]!, imageUrl);
		}
		for (const eventMatch of section.matchAll(/\/events\/(\d+)/gi)) {
			map.set(`event:${eventMatch[1]!}`, imageUrl);
		}
	}
	return map;
}

/**
 * Clean partner HTML/JSON-LD text for public descriptions.
 * SeatEngine/JSON-LD often ships literal "\n" escape sequences and leading junk.
 */
function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		// Literal escape sequences (not real newlines) from JSON-LD / API strings
		.replace(/\\n/g, " ")
		.replace(/\\r/g, " ")
		.replace(/\\t/g, " ")
		.replace(/\\"/g, '"')
		// Real newlines / whitespace → single spaces for clean prose
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Prefer show description over venue boilerplate on Cap City event pages. */
export function extractSeatEngineEventDescription(html: string, jsonLdDescription?: string | null): string | null {
	const candidates: string[] = [];
	if (jsonLdDescription) candidates.push(stripHtml(jsonLdDescription));

	for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
		candidates.push(stripHtml(m[1] ?? ""));
	}

	const isBoilerplate = (t: string) =>
		/only top tier comedy club/i.test(t) ||
		/management reserves the right/i.test(t) ||
		/all lineups subject to change/i.test(t) ||
		/two-item showroom minimum/i.test(t) ||
		/ticket protection/i.test(t) ||
		/century oaks terrace/i.test(t) ||
		/service fees help cover/i.test(t) ||
		t.length < 40;

	const good = candidates.find((t) => t.length >= 40 && !isBoilerplate(t));
	if (!good) return null;
	return good.replace(/^[\s\u00a0\\n\\r]+/, "").slice(0, 4000);
}

type JsonLdEvent = {
	name?: string;
	startDate?: string;
	description?: string;
	image?: string | string[];
	url?: string;
};

function parseJsonLdEvents(html: string): JsonLdEvent[] {
	const out: JsonLdEvent[] = [];
	for (const block of html.matchAll(
		/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		const raw = (block[1] ?? "").trim();
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as unknown;
			const items = Array.isArray(parsed) ? parsed : [parsed];
			for (const item of items) {
				if (!item || typeof item !== "object") continue;
				const rec = item as Record<string, unknown>;
				const type = rec["@type"];
				const isEvent =
					type === "Event" ||
					(Array.isArray(type) && type.some((t) => String(t).toLowerCase() === "event"));
				if (!isEvent) continue;
				const startDate = typeof rec.startDate === "string" ? rec.startDate : null;
				if (!startDate) continue;
				out.push({
					name: typeof rec.name === "string" ? rec.name : undefined,
					startDate,
					description: typeof rec.description === "string" ? rec.description : undefined,
					image:
						typeof rec.image === "string"
							? rec.image
							: Array.isArray(rec.image)
								? (rec.image.find((x) => typeof x === "string") as string | undefined)
								: undefined,
					url: typeof rec.url === "string" ? rec.url : undefined,
				});
			}
		} catch {
			// ignore malformed JSON-LD
		}
	}
	return out;
}

/** Months to fetch so scrape window is covered (calendar is month-grid based). */
export function seatEngineMonthsToCover(scrapeDaysAhead: number, from = new Date()): { month: number; year: number }[] {
	const days = Math.max(1, scrapeDaysAhead);
	const monthCount = Math.min(12, Math.max(1, Math.ceil(days / 28) + 1));
	const out: { month: number; year: number }[] = [];
	for (let i = 0; i < monthCount; i++) {
		const d = new Date(from.getFullYear(), from.getMonth() + i, 1);
		out.push({ month: d.getMonth() + 1, year: d.getFullYear() });
	}
	return out;
}

function calendarUrlForMonth(calendarUrl: string, month: number, year: number, isFirst: boolean): string {
	const u = new URL(calendarUrl);
	// Cap City: /calendar or /calendar?month=8&year=2026
	if (u.pathname.replace(/\/$/, "").endsWith("/calendar") || /capcitycomedy\.com/i.test(calendarUrl)) {
		if (isFirst && !u.searchParams.has("month")) {
			// Keep canonical current-month URL as provided
			return calendarUrl;
		}
		u.searchParams.set("month", String(month));
		u.searchParams.set("year", String(year));
		return u.toString();
	}
	// Generic: append month/year query when path looks like a calendar
	if (/calendar/i.test(u.pathname)) {
		u.searchParams.set("month", String(month));
		u.searchParams.set("year", String(year));
		return u.toString();
	}
	return calendarUrl;
}

/** Fetch multi-month calendar HTML (Cap City chevron navigation). */
export async function fetchSeatEngineCalendarMonths(
	calendarUrl: string,
	scrapeDaysAhead: number,
): Promise<string> {
	const result = await fetchSeatEngineCalendarMonthsDetailed(calendarUrl, scrapeDaysAhead);
	return result.combinedHtml;
}

/** Multi-month calendar fetch with dated event id entries for reverse-chron walk. */
export async function fetchSeatEngineCalendarMonthsDetailed(
	calendarUrl: string,
	scrapeDaysAhead: number,
): Promise<{
	combinedHtml: string;
	entries: { eventId: string; day: number; month: number; year: number; sortKey: number }[];
}> {
	const months = seatEngineMonthsToCover(scrapeDaysAhead);
	const chunks: string[] = [];
	const entries: { eventId: string; day: number; month: number; year: number; sortKey: number }[] =
		[];
	for (let i = 0; i < months.length; i++) {
		const { month, year } = months[i]!;
		const url = calendarUrlForMonth(calendarUrl, month, year, i === 0);
		try {
			const html = await fetchPageText(url);
			chunks.push(html);
			entries.push(...extractSeatEngineEventEntries(html, month, year));
		} catch {
			// skip failed month
		}
		if (i < months.length - 1) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}
	return { combinedHtml: chunks.join("\n"), entries };
}

function parseSeatEngineClock(raw: string): string | null {
	const match = raw.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
	if (!match) return null;
	const month = match[1];
	const day = match[2];
	const year = match[3];
	let hour = Number(match[4]) % 12;
	if (match[6]!.toUpperCase() === "PM") hour += 12;
	return `${year}-${month}-${day} ${String(hour).padStart(2, "0")}:${match[5]}:00`;
}

async function parseShowPage(
	showUrl: string,
	showId: string,
	venueName: string,
	address: string | null,
	timezone: string,
	calendarImageMap: Map<string, string>,
	wixMediaMap: Map<string, { image_url: string | null; description: string | null; more_info_url: string }>,
	baseOrigin: string,
): Promise<PartnerEvent[]> {
	const html = await fetchPageText(showUrl);
	const title = html
		.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
		?.replace(/<[^>]+>/g, "")
		.trim();
	if (!title) return [];

	// Prefer JSON-LD when present (Cap City / modern SeatEngine)
	const ldEvents = parseJsonLdEvents(html);
	if (ldEvents.length > 0) {
		const imageUrl =
			(typeof ldEvents[0]?.image === "string" ? ldEvents[0].image : null) ??
			calendarImageMap.get(showId) ??
			extractSeatEngineTalentImage(html);
		const description = extractSeatEngineEventDescription(html, ldEvents[0]?.description);
		const eventId = html.match(/\/events\/(\d+)/i)?.[1] ?? null;
		const eventPageUrl = eventId ? `${baseOrigin}/events/${eventId}` : showUrl;
		const out: PartnerEvent[] = [];
		const seen = new Set<string>();
		for (const ld of ldEvents) {
			if (!ld.startDate) continue;
			const startsAt = ld.startDate.includes("T")
				? new Date(ld.startDate).toISOString()
				: ld.startDate;
			if (Number.isNaN(Date.parse(startsAt))) continue;
			if (seen.has(startsAt)) continue;
			seen.add(startsAt);
			out.push(
				toPartnerEvent({
					title: ld.name?.trim() || title,
					starts_at: startsAt,
					venue_name: venueName,
					address,
					description: extractSeatEngineEventDescription(html, ld.description) ?? description,
					image_url: imageUrl,
					source_url: eventPageUrl,
					source_partner: "seatengine",
					source_event_id: `${showUrl}#${startsAt}`,
					raw_date_text: ld.startDate,
					ticket_url: eventPageUrl,
					confidence: 1,
				}),
			);
		}
		if (out.length) return out;
	}

	const times = [...html.matchAll(/(\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/gi)].map(
		(m) => m[1]!,
	);
	const eventId = html.match(/\/events\/(\d+)/i)?.[1] ?? null;
	const wixMedia = wixMediaMap.get(showId) ?? (eventId ? wixMediaMap.get(eventId) : undefined);
	const imageUrl =
		wixMedia?.image_url ?? calendarImageMap.get(showId) ?? extractSeatEngineTalentImage(html);
	const description =
		wixMedia?.description ?? extractSeatEngineEventDescription(html) ?? null;
	const eventPageUrl = eventId ? `${baseOrigin}/events/${eventId}` : null;
	const ticketUrl = eventPageUrl ?? showUrl;

	const events: PartnerEvent[] = [];
	const seen = new Set<string>();
	for (const rawTime of times) {
		const local = parseSeatEngineClock(rawTime);
		if (!local) continue;
		let startsAt: string;
		try {
			startsAt = localWallTimeToUtcIso(local, timezone);
		} catch {
			continue;
		}
		if (seen.has(startsAt)) continue;
		seen.add(startsAt);
		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				venue_name: venueName,
				address,
				description,
				image_url: imageUrl,
				source_url: wixMedia?.more_info_url ?? ticketUrl,
				source_partner: "seatengine",
				source_event_id: `${showUrl}#${startsAt}`,
				raw_date_text: rawTime,
				ticket_url: ticketUrl,
				confidence: 1,
			}),
		);
	}
	return events;
}

/** Cap City path: /events/{id} page with one JSON-LD Event per performance. */
async function parseEventListingPage(
	eventUrl: string,
	eventId: string,
	venueName: string,
	address: string | null,
	calendarImageMap: Map<string, string>,
): Promise<PartnerEvent[]> {
	const html = await fetchPageText(eventUrl);
	const h1 = html
		.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
		?.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const ldEvents = parseJsonLdEvents(html);
	const imageUrl =
		calendarImageMap.get(`event:${eventId}`) ??
		(typeof ldEvents[0]?.image === "string" ? ldEvents[0].image : null) ??
		extractSeatEngineTalentImage(html);
	const pageDescription = extractSeatEngineEventDescription(html, ldEvents[0]?.description);

	if (ldEvents.length === 0) {
		// No structured times — skip rather than invent
		return [];
	}

	const out: PartnerEvent[] = [];
	const seen = new Set<string>();
	for (const ld of ldEvents) {
		if (!ld.startDate) continue;
		const startsAt = ld.startDate.includes("T")
			? new Date(ld.startDate).toISOString()
			: ld.startDate;
		if (Number.isNaN(Date.parse(startsAt))) continue;
		if (seen.has(startsAt)) continue;
		seen.add(startsAt);
		const title = (ld.name || h1 || `Event ${eventId}`).trim();
		out.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				venue_name: venueName,
				address,
				description:
					extractSeatEngineEventDescription(html, ld.description) ?? pageDescription,
				image_url: imageUrl,
				source_url: eventUrl,
				source_partner: "seatengine",
				source_event_id: `seatengine:event:${eventId}#${startsAt}`,
				raw_date_text: ld.startDate,
				ticket_url: eventUrl,
				confidence: 1,
			}),
		);
	}
	return out;
}

export async function fetchSeatEngineEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxShows?: number;
	websiteUrl?: string | null;
	/**
	 * SeatEngine /events/{id} already published in our DB.
	 * Skip detail fetches for these (calendar may add new shows between known dates).
	 */
	knownEventIds?: Iterable<string> | null;
	/** When true, ignore knownEventIds and re-fetch every listing (pilot retrain). */
	forceFullScan?: boolean;
}): Promise<PartnerEvent[]> {
	const maxItems = params.maxShows ?? 80;
	const base = new URL(params.calendarUrl).origin;
	const cutoff = Date.now() + params.scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const now = Date.now() - 60 * 60 * 1000; // allow slight past for late scrapes
	const forceFull = params.forceFullScan === true;
	const known = new Set(
		forceFull
			? []
			: [...(params.knownEventIds ?? [])].map(String).filter((id) => /^\d+$/.test(id)),
	);

	// Multi-month walk for Cap City / se-calendar grids
	const useEventGrid = isSeatEngineEventGrid(params.calendarHtml, params.calendarUrl);
	let combinedHtml = params.calendarHtml;
	let datedEntries: { eventId: string; day: number; month: number; year: number; sortKey: number }[] =
		[];
	if (useEventGrid || /calendar/i.test(params.calendarUrl)) {
		try {
			const multi = await fetchSeatEngineCalendarMonthsDetailed(
				params.calendarUrl,
				params.scrapeDaysAhead,
			);
			if (multi.combinedHtml.length > params.calendarHtml.length / 2) {
				combinedHtml = multi.combinedHtml;
				datedEntries = multi.entries;
			}
		} catch {
			// keep single-page html
		}
	}
	if (datedEntries.length === 0) {
		// Single-page fallback: approximate current month
		const nowD = new Date();
		datedEntries = extractSeatEngineEventEntries(
			combinedHtml,
			nowD.getMonth() + 1,
			nowD.getFullYear(),
		);
	}

	const calendarImageMap = buildShowImageMapFromCalendar(combinedHtml);
	// Only listings that appear on a calendar day inside the scrape window (avoids burning
	// maxShows on far-out pages whose performances are all filtered by cutoff).
	const windowEntries = datedEntries.filter(
		(e) => e.sortKey >= now - 2 * 24 * 60 * 60 * 1000 && e.sortKey <= cutoff,
	);
	const entriesForOrder = windowEntries.length > 0 ? windowEntries : datedEntries;
	// Nearest-first: fill the review queue with soonest shows; skip already known ids
	const eventIdsOrdered = orderSeatEngineEventIdsByDate(entriesForOrder, "nearest");
	const eventIdsFallback = extractSeatEngineEventIds(combinedHtml);
	const allEventIds = eventIdsOrdered.length > 0 ? eventIdsOrdered : eventIdsFallback;
	// Skip detail pages we already publish/stage; still scan full calendar for mid-range adds
	const eventIds = allEventIds.filter((id) => !known.has(id)).slice(0, maxItems);
	const showIds = extractSeatEngineShowIds(combinedHtml)
		.filter((id) => !known.has(id))
		.slice(0, maxItems);

	const idsForMedia = [...new Set([...showIds, ...eventIds])];
	const wixMediaMap = params.websiteUrl
		? await fetchWixVelvShowMedia(params.websiteUrl, idsForMedia, maxItems)
		: new Map();

	const events: PartnerEvent[] = [];
	const seenKeys = new Set<string>();

	const pushUnique = (list: PartnerEvent[]) => {
		for (const event of list) {
			const t = new Date(event.starts_at).getTime();
			if (Number.isNaN(t) || t > cutoff || t < now) continue;
			const key = `${event.title}|${event.starts_at}`;
			if (seenKeys.has(key)) continue;
			seenKeys.add(key);
			events.push(event);
		}
	};

	// Cap City primary path: only unknown /events/{id} pages (skip already published)
	if (useEventGrid && (eventIds.length > 0 || known.size > 0)) {
		let fetched = 0;
		const concurrency = 4;
		for (let i = 0; i < eventIds.length; i += concurrency) {
			const batch = eventIds.slice(i, i + concurrency);
			const results = await Promise.all(
				batch.map(async (eventId) => {
					try {
						return await parseEventListingPage(
							`${base}/events/${eventId}`,
							eventId,
							params.venueName,
							params.address,
							calendarImageMap,
						);
					} catch {
						return [] as PartnerEvent[];
					}
				}),
			);
			for (const list of results) {
				pushUnique(list);
				fetched++;
			}
			if (i + concurrency < eventIds.length) {
				await new Promise((r) => setTimeout(r, 80));
			}
		}
		// Empty unknown set is a successful incremental no-op
		if (events.length > 0 || fetched > 0 || known.size > 0) {
			return events;
		}
	}

	// Classic path: /shows/{id} pages (unknown only)
	for (const id of showIds) {
		try {
			const showEvents = await parseShowPage(
				`${base}/shows/${id}`,
				id,
				params.venueName,
				params.address,
				params.timezone,
				calendarImageMap,
				wixMediaMap,
				base,
			);
			pushUnique(showEvents);
		} catch {
			// skip
		}
	}

	// Fallback: event pages if classic path found nothing
	if (events.length === 0 && eventIds.length > 0) {
		const concurrency = 4;
		for (let i = 0; i < eventIds.length; i += concurrency) {
			const batch = eventIds.slice(i, i + concurrency);
			const results = await Promise.all(
				batch.map(async (eventId) => {
					try {
						return await parseEventListingPage(
							`${base}/events/${eventId}`,
							eventId,
							params.venueName,
							params.address,
							calendarImageMap,
						);
					} catch {
						return [] as PartnerEvent[];
					}
				}),
			);
			for (const list of results) pushUnique(list);
			if (i + concurrency < eventIds.length) {
				await new Promise((r) => setTimeout(r, 80));
			}
		}
	}

	return events;
}
