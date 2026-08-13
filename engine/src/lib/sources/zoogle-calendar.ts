/**
 * Zoogle / Elephant Room-style calendars.
 *
 * Listing pages load additional months via turbo_stream:
 *   /calendar/features/load/calendar_feature_{id}.turbo_stream?calendar_page=N
 *
 * Each show is:
 *   <div class="event-detail" data-event-id="..." data-occurrence-id="...">
 *     thumbnail + data-featherlight larger image on zoogletools.com
 *     title, datetime, description
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";

async function fetchLight(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 events-platform-zoogle",
			Accept: "text/html,application/xhtml+xml,*/*",
		},
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.text();
}

export function isZoogleCalendar(html: string, pageUrl: string): boolean {
	const haystack = `${pageUrl}\n${html}`.toLowerCase();
	return (
		/zoogletools\.com|event-detail|calendar_feature_|data-occurrence-id/i.test(haystack) ||
		/elephantroom\.com\/calendar/i.test(pageUrl)
	);
}

function absUrl(href: string, base: string): string {
	if (!href) return "";
	if (href.startsWith("//")) return `https:${href}`;
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
}

function stripHtml(value: string): string {
	// Strip tags first, then decode entities (order matters for nested &amp;)
	let text = value
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<svg[\s\S]*?<\/svg>/gi, "")
		.replace(/<[^>]+>/g, " ");
	// Named + numeric entities
	text = text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
	// Second pass for double-encoded &amp;amp;
	text = text.replace(/&amp;/gi, "&");
	return text.replace(/\s+/g, " ").trim();
}

/** True when extracted "description" is share-widget/SVG junk, not a real blurb. */
export function isJunkZoogleDescription(text: string | null | undefined): boolean {
	if (!text) return true;
	if (text.length < 15) return true;
	return /popup-window|share-dialog|data-controller|data-action|button-tertiary|fill-rule|javascript:|zoogle-share|path\s+fill/i.test(
		text,
	);
}

const MONTHS: Record<string, number> = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

/** Parse "Thursday, July 9 @ 6:00PM" or "Thu, Jul 9 @ 6:00PM" into local wall time. */
export function parseZoogleDateTime(
	text: string,
	timezone: string,
	preferYear: number,
): string | null {
	const m = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,\s*(\d{4}))?\s*@\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i,
	);
	if (!m) return null;
	const mon = MONTHS[m[1].toLowerCase()];
	if (!mon) return null;
	const day = Number(m[2]);
	let year = m[3] ? Number(m[3]) : preferYear;
	let hour = Number(m[4]);
	const minute = m[5];
	const ap = m[6].toUpperCase();
	if (ap === "PM" && hour < 12) hour += 12;
	if (ap === "AM" && hour === 12) hour = 0;

	// If date without year is more than ~2 months in the past vs "today" in preferYear, roll to next year
	const candidate = new Date(Date.UTC(year, mon - 1, day, 12));
	const now = new Date();
	if (!m[3] && candidate.getTime() < now.getTime() - 45 * 864e5) {
		year += 1;
	}

	const wall = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${minute}:00`;
	return localWallTimeToUtcIso(wall, timezone);
}

export function extractZoogleFeatureId(html: string, pageUrl: string): string | null {
	const fromHtml =
		html.match(/calendar_feature_(\d+)/i)?.[1] ??
		html.match(/features\/load\/calendar_feature_(\d+)/i)?.[1];
	if (fromHtml) return fromHtml;
	// Elephant Room known feature id (stable)
	if (/elephantroom\.com/i.test(pageUrl)) return "1147558";
	return null;
}

export function parseZoogleEventBlocks(
	html: string,
	pageUrl: string,
	venueName: string,
	address: string | null,
	timezone: string,
): PartnerEvent[] {
	const preferYear = new Date().getFullYear();
	const events: PartnerEvent[] = [];
	const parts = html.split(/class="event-detail"/i).slice(1);

	for (const part of parts) {
		const eventId = part.match(/data-event-id="(\d+)"/i)?.[1];
		const occId = part.match(/data-occurrence-id="(\d+)"/i)?.[1];
		if (!eventId) continue;

		const title =
			stripHtml(part.match(/class="[^"]*event-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "") ||
			stripHtml(part.match(/title="([^"]+)"/i)?.[1] ?? "") ||
			null;
		if (!title) continue;

		// Full datetime is under .event-datetime (nested .date + .time spans)
		const datetimeText =
			stripHtml(part.match(/class="[^"]*event-datetime[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "") ||
			stripHtml(part.match(/class="[^"]*event-when[^"]*"[^>]*>([\s\S]*?)<\/time>/i)?.[1] ?? "");
		const startsAt = parseZoogleDateTime(datetimeText, timezone, preferYear);
		if (!startsAt) continue;

		// Prefer larger featherlight image over 200px thumbnail
		const large =
			part.match(/data-featherlight="([^"]+)"/i)?.[1] ??
			part.match(/class="thumbnail-popup"[^>]*href="([^"]+)"/i)?.[1] ??
			null;
		const thumb = part.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null;
		const imageUrl = absUrl(large || thumb || "", pageUrl) || null;

		// Elephant Room puts the blurb in .event-notes > p (only this — never share widgets)
		const notesHtml =
			part.match(/class="[^"]*event-notes[^"]*"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ??
			part.match(/class="[^"]*event-notes[^"]*"[^>]*>\s*([\s\S]*?)<\/div>/i)?.[1] ??
			"";
		const proseRaw = stripHtml(notesHtml);
		const prose =
			proseRaw.length > 20 && !isJunkZoogleDescription(proseRaw) ? proseRaw : null;

		const eventUrl =
			part.match(/href="(https?:\/\/[^"]*\/event\/[^"]+)"/i)?.[1] ??
			`${new URL(pageUrl).origin}/event/${eventId}/${occId ?? ""}`;

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: venueName,
				address,
				description: prose || null,
				image_url: imageUrl,
				source_url: eventUrl,
				source_partner: "zoogle",
				source_event_id: occId ? `${eventId}:${occId}` : eventId,
				raw_date_text: datetimeText,
				price_text: null,
				ticket_url: eventUrl,
				confidence: 0.92,
			}),
		);
	}

	return events;
}

export async function fetchZoogleEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	maxPages?: number;
}): Promise<PartnerEvent[]> {
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 90;
	const cutoff = Date.now() + scrapeDaysAhead * 864e5;
	const maxPages = params.maxPages ?? 7;
	const featureId = extractZoogleFeatureId(params.calendarHtml, params.calendarUrl);
	const origin = new URL(params.calendarUrl).origin;

	const pagesHtml: string[] = [params.calendarHtml];
	if (featureId) {
		for (let page = 1; page <= maxPages; page++) {
			const url = `${origin}/calendar/features/load/calendar_feature_${featureId}.turbo_stream?calendar_page=${page}`;
			try {
				const html = await fetchLight(url);
				if (!/event-detail/i.test(html)) break;
				pagesHtml.push(html);
				// last page often shorter
				const count = (html.match(/data-event-id=/gi) || []).length;
				if (count < 15 && page > 1) break;
			} catch {
				break;
			}
		}
	}

	const seen = new Set<string>();
	const events: PartnerEvent[] = [];
	for (const html of pagesHtml) {
		for (const ev of parseZoogleEventBlocks(
			html,
			params.calendarUrl,
			params.venueName,
			params.address,
			params.timezone,
		)) {
			const key = ev.source_event_id ?? `${ev.title}|${ev.starts_at}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const t = new Date(ev.starts_at).getTime();
			if (Number.isNaN(t) || t > cutoff) continue;
			if (t < Date.now() - 864e5) continue;
			events.push(ev);
		}
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}
