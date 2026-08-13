/**
 * Squarespace "User Items List" calendar parser.
 *
 * Structure (29th Street Ballroom /upcoming):
 *   div.user-items-list
 *     li.list-item
 *       img.list-image | data-image  → image
 *       .list-item-content__title    → title
 *       .list-item-content__description → date text (e.g. "July 9, 2026")
 *       a.list-item-content__button  → ticket URL ("GET TICKETS")
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

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

export function isSquarespaceUserItemsList(html: string, pageUrl?: string): boolean {
	const hay = `${pageUrl ?? ""}\n${html}`;
	return (
		/user-items-list/i.test(hay) &&
		/list-item/i.test(hay) &&
		(/list-item-content__title|list-item-content__button|squarespace/i.test(hay) ||
			/29thstreetballroom\.com/i.test(hay))
	);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/\s+/g, " ")
		.trim();
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parseDateText(text: string): { ymd: string; raw: string } | null {
	const full = text.match(
		/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
	);
	if (full) {
		const month = MONTHS[full[1].toLowerCase()];
		const day = Number(full[2]);
		const year = Number(full[3]);
		if (!month) return null;
		return {
			ymd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
			raw: full[0],
		};
	}
	const abbr = text.match(
		/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i,
	);
	if (!abbr) return null;
	const month = MONTHS[abbr[1].toLowerCase()];
	const day = Number(abbr[2]);
	const year = Number(abbr[3]);
	if (!month) return null;
	return {
		ymd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
		raw: abbr[0],
	};
}

function defaultLocalTime(text: string): string {
	// Matinee cards often note it explicitly
	if (/\bmatinee\b/i.test(text)) return "14:00:00";
	// Default evening show (Austin clubs) when only a date is published
	return "20:00:00";
}

function extractListItems(html: string): string[] {
	const items: string[] = [];
	const re = /<li\b[^>]*class="[^"]*\blist-item\b[^"]*"[^>]*>/gi;
	const starts: number[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) starts.push(m.index);
	for (let i = 0; i < starts.length; i++) {
		const start = starts[i];
		const end = i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, start + 12_000);
		items.push(html.slice(start, end));
	}
	return items;
}

export function parseSquarespaceUserItemsList(params: {
	html: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
}): PartnerEvent[] {
	const {
		html,
		calendarUrl,
		venueName,
		address = null,
		timezone,
		scrapeDaysAhead = 365,
	} = params;

	const now = Date.now();
	const cutoff = now + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const chunk of extractListItems(html)) {
		const titleHtml =
			chunk.match(/list-item-content__title[^>]*>([\s\S]*?)<\//i)?.[1] ??
			chunk.match(/class="[^"]*list-item-content__title[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1];
		const title = titleHtml ? stripTags(titleHtml) : "";
		if (!title || title.length < 2) continue;

		const descHtml =
			chunk.match(/list-item-content__description[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
			chunk.match(/class="[^"]*list-item-content__description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
			"";
		const descText = stripTags(descHtml);
		const wholeText = stripTags(chunk);

		const dateParsed = parseDateText(descText) || parseDateText(wholeText);
		if (!dateParsed) continue;

		const ticketUrl =
			chunk.match(
				/<a\b[^>]*class="[^"]*list-item-content__button[^"]*"[^>]*href=["']([^"']+)["']/i,
			)?.[1] ??
			chunk.match(
				/href=["']([^"']+)["'][^>]*class="[^"]*list-item-content__button[^"]*"/i,
			)?.[1] ??
			chunk.match(/href=["'](https?:\/\/(?:www\.)?etix\.com\/[^"']+)["']/i)?.[1] ??
			chunk.match(/href=["'](https?:\/\/(?:www\.)?eventbrite\.com\/[^"']+)["']/i)?.[1] ??
			null;

		const imageUrl =
			chunk.match(/\bdata-image=["']([^"']+)["']/i)?.[1] ??
			chunk.match(/<img[^>]+class="[^"]*list-image[^"]*"[^>]+src=["']([^"']+)["']/i)?.[1] ??
			chunk.match(/src=["'](https:\/\/images\.squarespace-cdn\.com[^"']+)["']/i)?.[1] ??
			null;

		const clock = defaultLocalTime(`${descText} ${title} ${wholeText}`);
		let startsAt: string;
		try {
			startsAt = localWallTimeToUtcIso(`${dateParsed.ymd} ${clock}`, timezone);
		} catch {
			continue;
		}

		const startMs = new Date(startsAt).getTime();
		if (Number.isNaN(startMs)) continue;
		// Allow events earlier today; drop far past and beyond window
		if (startMs < now - 12 * 60 * 60 * 1000) continue;
		if (startMs > cutoff) continue;

		const sourceEventId = ticketUrl
			? `sqs-ticket:${ticketUrl.replace(/^https?:\/\//i, "").replace(/\/$/, "")}`
			: `sqs:${title.toLowerCase()}|${dateParsed.ymd}`;

		const dedupeKey = `${title.toLowerCase()}|${startsAt}|${ticketUrl ?? ""}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: venueName,
				address,
				description: descText || null,
				image_url: imageUrl,
				source_url: ticketUrl || calendarUrl,
				source_partner: "squarespace_user_items",
				source_event_id: sourceEventId,
				raw_date_text: dateParsed.raw,
				ticket_url: ticketUrl,
				confidence: ticketUrl ? 0.92 : 0.85,
			}),
		);
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

export async function fetchSquarespaceUserItemsEvents(params: {
	calendarHtml?: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
}): Promise<PartnerEvent[]> {
	const html = params.calendarHtml ?? (await fetchPageText(params.calendarUrl));
	return parseSquarespaceUserItemsList({
		html,
		calendarUrl: params.calendarUrl,
		venueName: params.venueName,
		address: params.address,
		timezone: params.timezone,
		scrapeDaysAhead: params.scrapeDaysAhead,
	});
}
