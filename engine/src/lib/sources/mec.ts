import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

const MONTHS: Record<string, number> = {
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
	jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function decodeEntities(value: string): string {
	return value
		.replace(/&#x2F;/gi, "/")
		.replace(/&#x3A;/gi, ":")
		.replace(/&#x7E;/gi, "~")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");
}

function cleanText(value: string): string {
	return decodeEntities(value).replace(/<[^>]+>/g, "").trim();
}

export function isMecCalendar(html: string, pageUrl: string): boolean {
	const haystack = `${pageUrl}\n${html}`.toLowerCase();
	return /\/all-events\/|modern-events-calendar|mec-calendar|cat_ids~|mec-events/i.test(haystack);
}

function normalizeAgendaLimit(url: string, limit = 200): string {
	if (/events_limit~\d+/i.test(url)) {
		return url.replace(/events_limit~\d+/i, `events_limit~${limit}`);
	}
	const suffix = url.endsWith("/") ? "" : "/";
	return `${url}${suffix}events_limit~${limit}/`;
}

export function resolveMecAgendaUrl(html: string, pageUrl: string): string | null {
	const hrefMatch = html.match(
		/href=["']([^"']*\/all-events\/[^"']*action~agenda[^"']*request_format~html[^"']*)["']/i,
	);
	if (hrefMatch?.[1]) {
		return normalizeAgendaLimit(new URL(decodeEntities(hrefMatch[1]), pageUrl).toString());
	}

	const catId = html.match(/cat_ids~(\d+)/i)?.[1];
	if (catId) {
		return new URL(
			`/all-events/action~agenda/cat_ids~${catId}/events_limit~200/request_format~html/`,
			pageUrl,
		).toString();
	}

	return null;
}

export function buildMecMonthUrls(pageUrl: string, catId: string, scrapeDaysAhead: number): string[] {
	const base = new URL(pageUrl).origin;
	const now = new Date();
	const end = new Date(now.getTime() + scrapeDaysAhead * 24 * 60 * 60 * 1000);
	const urls: string[] = [];

	// Chevron month views: previous month + each month through the scrape horizon.
	const cursor = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const lastMonth = new Date(end.getFullYear(), end.getMonth(), 1);
	while (cursor <= lastMonth) {
		const y = cursor.getFullYear();
		const m = String(cursor.getMonth() + 1).padStart(2, "0");
		urls.push(
			`${base}/all-events/action~month/time~${y}-${m}-01/cat_ids~${catId}/events_limit~100/request_format~html/`,
		);
		cursor.setMonth(cursor.getMonth() + 1);
		if (urls.length >= 4) break;
	}

	return urls;
}

export function buildMecAgendaOffsets(agendaUrl: string): string[] {
	const urls = new Set<string>([agendaUrl]);
	const stem = agendaUrl.replace(/page_offset~-?\d+\//i, "");
	for (const offset of [-1, 1]) {
		if (/action~agenda\//i.test(stem)) {
			urls.add(stem.replace(/action~agenda\//i, `action~agenda/page_offset~${offset}/`));
		}
	}
	return [...urls];
}

export function extractMecEventSlugs(html: string): string[] {
	const slugs = new Set<string>();
	for (const match of html.matchAll(/event(?:&#x2F;|\/)([a-z0-9-]+)/gi)) {
		slugs.add(match[1]);
	}
	return [...slugs];
}

function inferYear(month: number, now = new Date()): number {
	const year = now.getFullYear();
	if (month < now.getMonth() + 1 - 2) return year + 1;
	return year;
}

function parseDisplayDate(text: string, fallbackYear?: number): string | null {
	const full = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
	);
	if (full) {
		const month = MONTHS[full[1].toLowerCase()];
		const day = Number(full[2]);
		const year = Number(full[3]);
		return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	}

	const abbr = text.match(
		/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i,
	);
	if (!abbr) return null;
	const month = MONTHS[abbr[1].toLowerCase()];
	const day = Number(abbr[2]);
	const year = fallbackYear ?? inferYear(month);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseClock(text: string): string | null {
	const match = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!match) return null;
	let hour = Number(match[1]) % 12;
	if (match[3].toLowerCase() === "pm") hour += 12;
	return `${hour}:${match[2]}:00`;
}

function pairDateTimes(dates: string[], times: string[]): Array<{ date: string; time: string }> {
	const uniqueDates = [...new Set(dates)];
	const uniqueTimes = [...new Set(times)];
	if (uniqueDates.length === 0 || uniqueTimes.length === 0) return [];

	if (uniqueDates.length === uniqueTimes.length) {
		return uniqueDates.map((date, i) => ({ date, time: uniqueTimes[i] }));
	}
	if (uniqueDates.length === 1) {
		return [{ date: uniqueDates[0], time: uniqueTimes[0] }];
	}
	return uniqueDates.map((date) => ({ date, time: uniqueTimes[0] }));
}

export function parseAi1ecAgendaEvents(
	html: string,
	timezone: string,
	baseUrl: string,
): PartnerEvent[] {
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const block of html.split(/<div class="ai1ec-event /i).slice(1)) {
		const title = cleanText(block.match(/class="ai1ec-event-title"[^>]*>([\s\S]*?)<\//i)?.[1] ?? "");
		const rawTime = cleanText(block.match(/class="ai1ec-event-time"[^>]*>([\s\S]*?)<\//i)?.[1] ?? "");
		if (!title || !rawTime) continue;

		const timeMatch = rawTime.match(
			/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\s+(\d{1,2})\s*@\s*(\d{1,2}:\d{2}\s*(?:am|pm))/i,
		);
		if (!timeMatch) continue;

		const datePart = parseDisplayDate(`${timeMatch[1]} ${timeMatch[2]}`);
		const clock = parseClock(timeMatch[3]);
		if (!datePart || !clock) continue;

		let startsAt: string;
		try {
			startsAt = localWallTimeToUtcIso(`${datePart} ${clock}`, timezone);
		} catch {
			continue;
		}
		if (seen.has(startsAt + title)) continue;
		seen.add(startsAt + title);

		const href = decodeEntities(block.match(/href="([^"]*\/event\/[^"]+)"/i)?.[1] ?? "");
		const ticketUrl =
			decodeEntities(block.match(/data-ticket-url="([^"]+)"/i)?.[1] ?? "") ||
			block.match(/href="(https?:\/\/[^"]+(?:ticket|dice\.fm|eventbrite)[^"]*)"/i)?.[1] ||
			null;
		const slug = href.match(/\/event\/([^/?#]+)/i)?.[1] ?? title.toLowerCase().replace(/\s+/g, "-");
		const instanceId = href.match(/instance_id=(\d+)/i)?.[1];
		const eventUrl = href
			? href.startsWith("http")
				? href
				: new URL(href, baseUrl).toString()
			: new URL(`/event/${slug}/`, baseUrl).toString();

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				venue_name: "",
				address: null,
				source_url: ticketUrl ?? eventUrl,
				source_partner: "mec",
				source_event_id: instanceId ? `${slug}#${instanceId}` : `${slug}#${startsAt}`,
				raw_date_text: rawTime,
				ticket_url: ticketUrl,
				confidence: 1,
			}),
		);
	}

	return events;
}

async function parseEventPage(
	eventUrl: string,
	venueName: string,
	address: string | null,
	timezone: string,
): Promise<PartnerEvent[]> {
	const html = await fetchPageText(eventUrl);
	const title = cleanText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
	if (!title) return [];

	const dates = [
		...html.matchAll(
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
		),
	].map((m) => m[0]);
	const times = [...html.matchAll(/\d{1,2}:\d{2}\s*(?:am|pm)/gi)].map((m) => m[0]);

	const imageUrl =
		html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ??
		null;

	const ticketUrl =
		html.match(/href=["'](https?:\/\/[^"']+(?:ticket|eventbrite|prekindle)[^"']*)["']/i)?.[1] ?? null;

	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const { date, time } of pairDateTimes(dates, times)) {
		const datePart = parseDisplayDate(date);
		const clock = parseClock(time);
		if (!datePart || !clock) continue;

		let startsAt: string;
		try {
			startsAt = localWallTimeToUtcIso(`${datePart} ${clock}`, timezone);
		} catch {
			continue;
		}
		if (seen.has(startsAt)) continue;
		seen.add(startsAt);

		const slug = new URL(eventUrl).pathname.split("/").filter(Boolean).pop() ?? eventUrl;
		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				venue_name: venueName,
				address,
				image_url: imageUrl,
				source_url: ticketUrl ?? eventUrl,
				source_partner: "mec",
				source_event_id: `${slug}#${startsAt}`,
				raw_date_text: `${date} ${time}`,
				ticket_url: ticketUrl,
				confidence: 1,
			}),
		);
	}

	return events;
}

async function fetchAgendaHtmlUnion(params: {
	calendarHtml: string;
	calendarUrl: string;
	scrapeDaysAhead: number;
}): Promise<string[]> {
	const agendaUrl = resolveMecAgendaUrl(params.calendarHtml, params.calendarUrl);
	if (!agendaUrl) {
		throw new Error("Could not resolve MEC agenda URL from calendar page");
	}

	const catId = params.calendarHtml.match(/cat_ids~(\d+)/i)?.[1] ?? agendaUrl.match(/cat_ids~(\d+)/i)?.[1];
	const monthUrls = catId ? buildMecMonthUrls(params.calendarUrl, catId, params.scrapeDaysAhead) : [];
	const urls = [...new Set([agendaUrl, ...buildMecAgendaOffsets(agendaUrl).slice(1), ...monthUrls])];

	const htmlPages: string[] = [];
	for (const url of urls.slice(0, 6)) {
		try {
			htmlPages.push(await fetchPageText(url));
		} catch {
			// Month/page chevrons may 404 when out of range — skip quietly.
		}
	}
	return htmlPages;
}

export async function fetchMecEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxEvents?: number;
}): Promise<PartnerEvent[]> {
	if (!isMecCalendar(params.calendarHtml, params.calendarUrl)) {
		throw new Error("Page does not look like a Modern Events Calendar listing");
	}

	const agendaPages = await fetchAgendaHtmlUnion(params);
	const cutoff = Date.now() + params.scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const combinedHtml = agendaPages.join("\n");
	const baseUrl = new URL(params.calendarUrl).origin;
	const agendaEvents = parseAi1ecAgendaEvents(combinedHtml, params.timezone, baseUrl).map((event) => ({
		...event,
		venue_name: params.venueName,
		address: params.address,
	}));

	const deduped = new Map<string, PartnerEvent>();
	for (const event of agendaEvents) {
		if (new Date(event.starts_at).getTime() > cutoff) continue;
		deduped.set(`${event.source_event_id}|${event.starts_at}`, event);
	}

	if (deduped.size > 0) {
		return [...deduped.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	}

	// Fallback: older themes without ai1ec agenda cards — fetch detail pages.
	const base = new URL(params.calendarUrl).origin;
	const slugs = extractMecEventSlugs(combinedHtml).slice(0, params.maxEvents ?? 20);
	const events: PartnerEvent[] = [];
	for (const slug of slugs) {
		const pageEvents = await parseEventPage(`${base}/event/${slug}/`, params.venueName, params.address, params.timezone);
		for (const event of pageEvents) {
			if (new Date(event.starts_at).getTime() <= cutoff) events.push(event);
		}
	}
	return events;
}