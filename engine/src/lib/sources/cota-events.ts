/**
 * Circuit of The Americas — list calendar (skip Germania concerts).
 *
 * List: https://circuitoftheamericas.com/events/?layout=list
 *   div.event-column.d-flex
 *   tag: a.event-tag  (skip "Concerts")
 *   title: h3 a
 *   date: div.event-date
 *   skip rows whose primary link is germaniaamp.com
 *
 * Detail (COTA /event/… pages):
 *   h1 title, .formula-date span, a.button → ticketmaster
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";
import { fetchPageText } from "./fetch-page";

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

export type CotaListRow = {
	title: string;
	tag: string;
	/** Raw list date text e.g. "September 4-6, 2026" */
	rawDate: string;
	/** YYYY-MM-DD start (first day of range) */
	startYmd: string;
	primaryUrl: string;
	imageUrl: string | null;
	isCotaDetail: boolean;
	slug: string | null;
};

export function isCotaEventsCalendar(html: string, pageUrl: string): boolean {
	if (/circuitoftheamericas\.com/i.test(pageUrl)) return true;
	return /event-column d-flex/i.test(html) && /event-date/i.test(html) && /event-tag/i.test(html);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/gi, "&")
		.replace(/&#8211;|&#8212;/g, "–")
		.replace(/&#038;/g, "&")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#0?39;|&apos;/gi, "'")
		.replace(/&#8217;|&#8216;/g, "'")
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&quot;/gi, '"')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\s+/g, " ")
		.trim();
}

function stripTags(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, " "));
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Parse list/detail date strings:
 *  - "September 4-6, 2026" → start Sep 4
 *  - "September 8, 2026"
 *  - "SEPTEMBER 11-13, 2026"
 *  - "May 7-9, 2027"
 */
export function parseCotaDateRange(raw: string): { startYmd: string; raw: string } | null {
	const text = decodeEntities(raw);
	const range = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s+(\d{4})/i,
	);
	if (range) {
		const mon = MONTHS[range[1].toLowerCase()];
		if (!mon) return null;
		return {
			startYmd: `${range[4]}-${pad2(mon)}-${pad2(Number(range[2]))}`,
			raw: text,
		};
	}
	const single = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
	);
	if (single) {
		const mon = MONTHS[single[1].toLowerCase()];
		if (!mon) return null;
		return {
			startYmd: `${single[3]}-${pad2(mon)}-${pad2(Number(single[2]))}`,
			raw: text,
		};
	}
	return null;
}

export function parseCotaListRows(html: string): CotaListRow[] {
	const parts = html.split(/(?=<div class="event-column d-flex\s*">)/i);
	const rows: CotaListRow[] = [];
	const seen = new Set<string>();

	for (const part of parts) {
		if (!/event-column d-flex/i.test(part)) continue;
		const chunk = part.slice(0, 2800);

		const tag = stripTags(chunk.match(/class="event-tag"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
		const title = stripTags(
			chunk.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "",
		);
		const rawDate = stripTags(chunk.match(/class="event-date"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
		if (!title || !rawDate) continue;

		// Skip live music → Germania Amp pilot owns those
		if (/concert/i.test(tag)) continue;

		const hrefs = [...chunk.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
		const germania = hrefs.find((h) => /germaniaamp\.com\/events\//i.test(h));
		if (germania) continue;

		const cotaDetail = hrefs.find((h) => /circuitoftheamericas\.com\/event\//i.test(h));
		const external =
			hrefs.find((h) =>
				/ticketmaster\.com|bikereg\.com|universe\.com|tixr\.com|am\.ticketmaster/i.test(h),
			) ?? null;
		const primaryUrl = cotaDetail ?? external ?? hrefs[0];
		if (!primaryUrl) continue;

		const parsed = parseCotaDateRange(rawDate);
		if (!parsed) continue;

		const key = `${title.toLowerCase()}|${parsed.startYmd}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const imageUrl =
			chunk.match(/background-image:\s*url\(([^)]+)\)/i)?.[1]?.replace(/['"]/g, "") ?? null;

		const slug = cotaDetail
			? cotaDetail.replace(/\/$/, "").split("/").pop() ?? null
			: null;

		rows.push({
			title,
			tag,
			rawDate: parsed.raw,
			startYmd: parsed.startYmd,
			primaryUrl,
			imageUrl,
			isCotaDetail: Boolean(cotaDetail),
			slug,
		});
	}

	return rows;
}

function parseDetailTicketUrl(html: string): string | null {
	// Prefer concrete ticketmaster.com event/artist links over generic am.ticketmaster.com/cota/
	const specific = html.match(
		/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/(?!.*venue\/)[^"']+)["']/i,
	)?.[1];
	if (specific && !/germania-insurance-amphitheater-tickets/i.test(specific)) {
		return specific.replace(/&amp;/g, "&");
	}
	const am = html.match(/href=["'](https?:\/\/am\.ticketmaster\.com\/cota\/[^"']*)["']/i)?.[1];
	if (am) return am.replace(/&amp;/g, "&");
	const any = html.match(
		/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/[^"']+)["']/i,
	)?.[1];
	return any ? any.replace(/&amp;/g, "&") : null;
}

function parseDetailFormulaDate(html: string): string | null {
	const span = html.match(
		/class="[^"]*formula-date[^"]*"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i,
	)?.[1];
	if (!span) return null;
	const text = stripTags(span);
	// Ignore non-date marketing copy ("Renew Your Spot for 2027")
	if (!parseCotaDateRange(text)) return null;
	return text;
}

function parseDetailTitle(html: string): string | null {
	const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	return h1 ? stripTags(h1) : null;
}

async function enrichCotaDetail(
	row: CotaListRow,
	timezone: string,
	venueName: string,
	address: string | null,
): Promise<PartnerEvent | null> {
	let title = row.title;
	let rawDate = row.rawDate;
	let startYmd = row.startYmd;
	let ticketUrl: string | null = null;
	let imageUrl = row.imageUrl;
	let description: string | null = null;

	if (row.isCotaDetail) {
		try {
			const html = await fetchPageText(row.primaryUrl);
			const dTitle = parseDetailTitle(html);
			if (dTitle) title = dTitle;
			const formula = parseDetailFormulaDate(html);
			if (formula) {
				const p = parseCotaDateRange(formula);
				if (p) {
					rawDate = p.raw;
					startYmd = p.startYmd;
				}
			}
			ticketUrl = parseDetailTicketUrl(html);
			const img =
				html.match(
					/class="[^"]*event-image[^"]*"[^>]*>[\s\S]{0,400}url\(([^)]+)\)/i,
				)?.[1]?.replace(/['"]/g, "") ??
				html.match(/property="og:image"\s+content=["']([^"']+)["']/i)?.[1] ??
				null;
			if (img) imageUrl = img;
			const para = html
				.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]
				?.replace(/<[^>]+>/g, " ");
			if (para && stripTags(para).length > 40) description = stripTags(para).slice(0, 2000);
		} catch {
			/* list data only */
		}
	} else {
		// External ticket / reg URL is the listing itself
		ticketUrl = row.primaryUrl;
	}

	// Default gate time: morning for multi-day motorsport, evening for single-day community
	const isRange = /[-–]/.test(rawDate);
	const clock = isRange ? "09:00:00" : "10:00:00";

	let startsAt: string;
	try {
		startsAt = localWallTimeToUtcIso(`${startYmd} ${clock}`, timezone);
	} catch {
		return null;
	}

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		venue_name: venueName,
		address,
		description,
		image_url: imageUrl,
		source_url: row.primaryUrl,
		source_partner: "cota",
		source_event_id: row.slug ?? `${title.toLowerCase().replace(/\s+/g, "-")}-${startYmd}`,
		raw_date_text: rawDate,
		ticket_url: ticketUrl,
		confidence: 1,
	});
}

export async function fetchCotaEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	maxEvents?: number;
}): Promise<PartnerEvent[]> {
	let listUrl = params.calendarUrl;
	if (!/[?&]layout=list/i.test(listUrl)) {
		const u = new URL(listUrl.includes("/events") ? listUrl : new URL("/events/", listUrl).toString());
		u.searchParams.set("layout", "list");
		listUrl = u.toString();
	}

	let html = params.calendarHtml;
	if (!/event-column d-flex/i.test(html) || !/layout=list/i.test(params.calendarUrl)) {
		html = await fetchPageText(listUrl);
	}

	const rows = parseCotaListRows(html);
	const now = Date.now() - 60 * 60 * 1000;
	const horizon = Date.now() + (params.scrapeDaysAhead ?? 400) * 24 * 60 * 60 * 1000;
	const max = params.maxEvents ?? 40;

	const events: PartnerEvent[] = [];
	for (const row of rows.slice(0, max)) {
		const ev = await enrichCotaDetail(row, params.timezone, params.venueName, params.address);
		if (!ev) continue;
		const t = new Date(ev.starts_at).getTime();
		if (t < now || t > horizon) continue;
		events.push(ev);
	}
	return events;
}
