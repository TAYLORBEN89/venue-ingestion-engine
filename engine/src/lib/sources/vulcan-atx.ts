/**
 * Vulcan Gas Company (vulcanatx.com) — Webflow CMS event list on homepage.
 *
 * List cards:
 *   .event-month (Jul) + .event-date (21) + .event-name + .event-time (8:00 pm)
 *   Tickets: a.button.primary → dice / etix / ticketsauce / etc.
 *
 * TicketSauce (vulcanatx.ticketsauce.com) supplements year/end times and images
 * for shows sold through their box office.
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

export function isVulcanAtxCalendar(html: string, pageUrl: string): boolean {
	if (/vulcanatx\.com/i.test(pageUrl)) return true;
	return (
		/event-name/i.test(html) &&
		/event-month/i.test(html) &&
		/event-date/i.test(html) &&
		/vulcanatx\.ticketsauce\.com|vulcangascompany|Vulcan Gas Company/i.test(html)
	);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/gi, "&")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#x27;|&#0?39;|&apos;/gi, "'")
		.replace(/&#8217;|&#8216;/g, "'")
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&quot;/gi, '"')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\\u002F/g, "/")
		.trim();
}

function stripHtml(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parseClock(text: string): string | null {
	const m = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!m) return null;
	let hour = Number(m[1]) % 12;
	if (m[3].toLowerCase() === "pm") hour += 12;
	return `${String(hour).padStart(2, "0")}:${m[2]}:00`;
}

function resolveYear(month: number, day: number, now = new Date()): number {
	const y = now.getFullYear();
	// If month is far behind calendar (e.g. listing still has last Dec in Jan), roll year
	const curM = now.getMonth() + 1;
	const curD = now.getDate();
	if (month < curM - 1) return y + 1;
	if (month === curM && day < curD - 1 && month < 3) return y; // still same year early
	// Late year listing next-year months early in year already handled; default current year
	if (month < curM || (month === curM && day < curD)) {
		// Past this year → next year only when clearly past (more than a day)
		if (month < curM - 0 || (month === curM && day < curD)) {
			// Keep past within scrape window filtered later; use current year for summer listings
			return y;
		}
	}
	return y;
}

function ymd(year: number, month: number, day: number): string {
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function eventKey(title: string, startsAt: string): string {
	return `${title.toLowerCase().replace(/\s+/g, " ").trim()}|${startsAt.slice(0, 16)}`;
}

type RawVulcan = {
	title: string;
	starts_at: string;
	ends_at: string | null;
	ticket_url: string | null;
	source_url: string;
	image_url: string | null;
	raw_date_text: string;
	source_event_id: string;
};

/** Parse homepage Webflow CMS list items. */
export function parseVulcanHomepage(html: string, pageUrl: string, now = new Date()): RawVulcan[] {
	const out: RawVulcan[] = [];
	// Each CMS item roughly: role="listitem" … event-month/date/name/time + Tickets
	const items = html.split(/role=["']listitem["']/i).slice(1);
	for (const chunk of items) {
		// Exact class tokens — avoid matching event-date-wrapper before event-date
		const title = stripHtml(chunk.match(/class=["']event-name["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		const monRaw = stripHtml(chunk.match(/class=["']event-month["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		const dayRaw = stripHtml(chunk.match(/class=["']event-date["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		const timeRaw = stripHtml(chunk.match(/class=["']event-time["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		if (!title || !monRaw || !dayRaw) continue;
		// Skip empty CMS shells
		if (/w-dyn-bind-empty/i.test(title) || title.length < 2) continue;

		const month = MONTHS[monRaw.toLowerCase().slice(0, 3)] ?? MONTHS[monRaw.toLowerCase()];
		const day = Number(dayRaw);
		if (!month || !day || day < 1 || day > 31) continue;

		const clock = parseClock(timeRaw) || "20:00:00";
		const year = resolveYear(month, day, now);
		const date = ymd(year, month, day);
		let starts_at: string;
		try {
			starts_at = localWallTimeToUtcIso(`${date} ${clock}`, "America/Chicago");
		} catch {
			continue;
		}

		const ticket =
			chunk.match(
				/href=["'](https?:\/\/[^"']*(?:ticketsauce|dice\.fm|etix|eventim|loop1tickets|ticketmaster|axs)[^"']*)["']/i,
			)?.[1] ??
			chunk.match(
				/class=["']button primary w-button["'][^>]*href=["'](https?:\/\/[^"']+)["']/i,
			)?.[1] ??
			chunk.match(
				/href=["'](https?:\/\/[^"']+)["'][^>]*class=["']button primary[^"']*["'][^>]*>/i,
			)?.[1] ??
			null;

		const ticket_url =
			ticket && !/^https?:\/\/(www\.)?vulcanatx\.com\/?$/i.test(ticket) && ticket !== "#"
				? decodeEntities(ticket)
				: null;

		const image =
			chunk.match(/src=["'](https?:\/\/[^"']+(?:website-files|uploads|cdn)[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i)?.[1] ??
			null;

		out.push({
			title,
			starts_at,
			ends_at: null,
			ticket_url,
			source_url: ticket_url || pageUrl,
			image_url: image ? decodeEntities(image) : null,
			raw_date_text: `${monRaw} ${day} ${year} ${timeRaw}`.trim(),
			source_event_id: `vulcan-home|${title}|${date}|${clock}`,
		});
	}
	return out;
}

/** Parse TicketSauce venue listing for full dates + end times. */
export function parseVulcanTicketSauce(html: string, pageUrl: string): RawVulcan[] {
	const out: RawVulcan[] = [];
	// Links like /e/slug with nearby date text "Tuesday, Jul 21, 2026 from 8:00 PM to 10:00 PM"
	const linkRe =
		/href=["'](https:\/\/vulcanatx\.ticketsauce\.com\/e\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<div[^>]*>([\s\S]*?)<\/div>/gi;
	let m: RegExpExecArray | null;
	const seen = new Set<string>();
	while ((m = linkRe.exec(html)) !== null) {
		const eventUrl = decodeEntities(m[1]);
		let title = stripHtml(m[2]);
		// TicketSauce list markup nests "More details" / "Tickets" around the real title
		title = title
			.replace(/^(More details\s*)+/i, "")
			.replace(/\s*Tickets\s*$/i, "")
			.replace(/^(Tickets\s*)+/i, "")
			.trim();
		const dateBlock = stripHtml(m[3]);
		if (!title || title.length < 2) continue;
		if (/^more details$/i.test(title)) continue;
		// Tuesday, Jul 21, 2026 from 8:00 PM to 10:00 PM
		// or Wednesday, Aug 12, 2026 at 9:00 PM
		const dm = dateBlock.match(
			/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\s+(?:from|at)\s+(\d{1,2}:\d{2}\s*[ap]m)(?:\s+to\s+(\d{1,2}:\d{2}\s*[ap]m))?/i,
		);
		if (!dm) continue;
		const month = MONTHS[dm[1].toLowerCase().slice(0, 3)];
		const day = Number(dm[2]);
		const year = Number(dm[3]);
		const startClock = parseClock(dm[4]);
		const endClock = dm[5] ? parseClock(dm[5]) : null;
		if (!month || !day || !startClock) continue;
		const date = ymd(year, month, day);
		let starts_at: string;
		try {
			starts_at = localWallTimeToUtcIso(`${date} ${startClock}`, "America/Chicago");
		} catch {
			continue;
		}
		let ends_at: string | null = null;
		if (endClock) {
			try {
				ends_at = localWallTimeToUtcIso(`${date} ${endClock}`, "America/Chicago");
			} catch {
				ends_at = null;
			}
		}
		const key = eventKey(title, starts_at);
		if (seen.has(key)) continue;
		seen.add(key);

		// image near this block — optional, search backward 800 chars
		const idx = m.index ?? 0;
		const window = html.slice(Math.max(0, idx - 900), idx + 200);
		const image =
			window.match(/src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i)?.[1] ?? null;

		out.push({
			title,
			starts_at,
			ends_at,
			ticket_url: eventUrl,
			source_url: eventUrl,
			image_url: image ? decodeEntities(image) : null,
			raw_date_text: dateBlock,
			source_event_id: `vulcan-ts|${eventUrl.split("/").pop()}`,
		});
	}
	return out;
}

function mergeRaw(a: RawVulcan[], b: RawVulcan[]): RawVulcan[] {
	const map = new Map<string, RawVulcan>();
	for (const e of [...a, ...b]) {
		const key = eventKey(e.title, e.starts_at);
		const prev = map.get(key);
		if (!prev) {
			map.set(key, e);
			continue;
		}
		// Prefer ticket sauce / richer fields
		map.set(key, {
			...prev,
			...e,
			title: e.title || prev.title,
			ticket_url: e.ticket_url || prev.ticket_url,
			image_url: e.image_url || prev.image_url,
			ends_at: e.ends_at || prev.ends_at,
			source_url: e.source_url || prev.source_url,
			raw_date_text: e.raw_date_text.length > prev.raw_date_text.length ? e.raw_date_text : prev.raw_date_text,
		});
	}
	return [...map.values()].sort((x, y) => x.starts_at.localeCompare(y.starts_at));
}

export async function fetchVulcanAtxEvents(params: {
	calendarHtml?: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
	maxEvents?: number;
}): Promise<PartnerEvent[]> {
	const daysAhead = params.scrapeDaysAhead ?? 120;
	const maxEvents = params.maxEvents ?? 80;
	const cutoff = Date.now() + daysAhead * 864e5;
	const past = Date.now() - 12 * 3600e3;

	const homeUrl = /vulcanatx\.com/i.test(params.calendarUrl)
		? params.calendarUrl.replace(/\/$/, "") || "https://www.vulcanatx.com"
		: "https://www.vulcanatx.com/";
	const homeHtml = params.calendarHtml ?? (await fetchPageText(homeUrl.endsWith("/") ? homeUrl : `${homeUrl}/`));

	const fromHome = parseVulcanHomepage(homeHtml, homeUrl.endsWith("/") ? homeUrl : `${homeUrl}/`);

	let fromTs: RawVulcan[] = [];
	try {
		const tsHtml = await fetchPageText("https://vulcanatx.ticketsauce.com/");
		fromTs = parseVulcanTicketSauce(tsHtml, "https://vulcanatx.ticketsauce.com/");
	} catch {
		// TicketSauce optional
	}

	const merged = mergeRaw(fromHome, fromTs).filter((e) => {
		const t = +new Date(e.starts_at);
		return t >= past && t <= cutoff;
	});

	return merged.slice(0, maxEvents).map((e) =>
		toPartnerEvent({
			title: e.title,
			starts_at: e.starts_at,
			ends_at: e.ends_at,
			venue_name: params.venueName,
			address: params.address,
			description: null,
			image_url: e.image_url,
			source_url: e.source_url,
			source_partner: "vulcan_atx",
			source_event_id: e.source_event_id,
			raw_date_text: e.raw_date_text,
			ticket_url: e.ticket_url,
			confidence: e.ticket_url ? 0.95 : 0.85,
		}),
	);
}
