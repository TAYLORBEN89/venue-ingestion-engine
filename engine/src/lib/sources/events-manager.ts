/**
 * WordPress Events Manager calendars (Hideout Theatre et al.).
 *
 * Page structure (user walkthrough — hideouttheatre.com/calendar/):
 *   section.em-cal-body.em-cal-days     → month grid of shows
 *   month nav chevrons → ?mo=N&yr=YYYY
 *   div.event_notes
 *     a[href*="event_id="]             → show URL + EM event id
 *     img.wp-post-image / attachment   → flyer
 *     span.event_name                  → title
 *     span.event_date                  → "Fri Jul 17, 7:30pm … $8 – $15"
 *     input[value="Buy Tickets"]       → tickets (same show URL)
 *     p…                               → description paragraphs
 *
 * Cloudflare often blocks bare fetch; prefer Browser Run (markdown or HTML).
 * Multi-month: crawl ?mo=&yr= for horizon (not single-month SSR only).
 */
import { renderMarkdown, renderPageContent } from "../browser";
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

const MONTH_NAMES: Record<string, number> = {
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
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

export function isEventsManagerCalendar(html: string, pageUrl: string): boolean {
	const hay = `${pageUrl}\n${html}`;
	if (/hideouttheatre\.com/i.test(pageUrl)) return true;
	if (/em-cal-body|em-cal-days|event_notes|event_name|events-manager/i.test(hay)) return true;
	if (/plugin[^"']*events-manager|events-manager\/v1/i.test(hay)) return true;
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
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#039;|&apos;/gi, "'")
		.replace(/&#8217;|&rsquo;/gi, "'")
		.replace(/&#8211;|&ndash;/gi, "–")
		.replace(/&#8212;|&mdash;/gi, "—")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\s+/g, " ")
		.trim();
}

function absUrl(src: string | null | undefined, baseUrl: string): string | null {
	if (!src) return null;
	const s = src.trim();
	if (!s || s.startsWith("data:")) return null;
	if (s.startsWith("//")) return `https:${s}`;
	if (s.startsWith("http://") || s.startsWith("https://")) return s;
	// Browser markdown sometimes drops the scheme: hideouttheatre.com/wp-content/...
	if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) return `https://${s}`;
	try {
		return new URL(s, baseUrl).toString();
	} catch {
		return null;
	}
}

function parseClock12(hour: number, min: number, ap: string): string {
	let h = hour;
	const a = ap.toLowerCase();
	if (a === "pm" && h < 12) h += 12;
	if (a === "am" && h === 12) h = 0;
	return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

/** "Fri Jul 17, 7:30pm" or "Fri. July 17th, 7:30pm" */
function parseEventDateTime(
	text: string,
	year: number,
): { ymd: string; clock: string; raw: string } | null {
	const m = text
		.replace(/\u202f/g, " ")
		.match(
			/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i,
		);
	if (!m) return null;
	const mon = MONTH_NAMES[m[1].toLowerCase().slice(0, 3)];
	if (!mon) return null;
	const day = Number(m[2]);
	const clock = parseClock12(Number(m[3]), Number(m[4]), m[5].replace(/\./g, ""));
	const ymd = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	return { ymd, clock, raw: m[0] };
}

function yearMonthFromCalendarUrl(url: string, htmlOrMd: string): { year: number; month: number } {
	const u = url.match(/[?&]mo=(\d{1,2}).*?[?&]yr=(\d{4})/i) || url.match(/[?&]yr=(\d{4}).*?[?&]mo=(\d{1,2})/i);
	if (u) {
		// first pattern mo then yr
		if (url.includes("mo=") && url.indexOf("mo=") < url.indexOf("yr=")) {
			return { month: Number(u[1]), year: Number(u[2]) };
		}
		if (/[?&]yr=\d{4}.*[?&]mo=/i.test(url)) {
			return { year: Number(u[1]), month: Number(u[2]) };
		}
		return { month: Number(u[1]), year: Number(u[2]) };
	}
	// Derive from prev/next chevron links: prev mo=N-1, next mo=N+1
	const mos = [...htmlOrMd.matchAll(/[?&]mo=(\d{1,2})&yr=(\d{4})/gi)].map((x) => ({
		mo: Number(x[1]),
		yr: Number(x[2]),
	}));
	if (mos.length >= 2) {
		const yrs = [...new Set(mos.map((m) => m.yr))];
		const year = yrs[0] ?? new Date().getFullYear();
		const months = mos.filter((m) => m.yr === year).map((m) => m.mo).sort((a, b) => a - b);
		if (months.length >= 2) {
			// current is between prev and next (e.g. 6 and 8 → 7)
			const lo = months[0]!;
			const hi = months[months.length - 1]!;
			if (hi === lo + 2) return { year, month: lo + 1 };
			if (lo === 12 && hi === 2) return { year, month: 1 };
		}
	}
	const now = new Date();
	return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function extractPrice(text: string): string | null {
	const m = text.match(/\$[\d.]+(?:\s*[–—\-]\s*\$[\d.]+)?/);
	return m?.[0] ?? null;
}

/** Parse hydrated HTML (preferred). */
export function parseEventsManagerHtml(params: {
	html: string;
	calendarUrl: string;
	year: number;
	venueName: string;
	address?: string | null;
	timezone?: string;
}): PartnerEvent[] {
	const { html, calendarUrl, year, venueName, address = null, timezone = "America/Chicago" } = params;
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	// Prefer calendar body when present
	const scope =
		html.match(/class=["'][^"']*\bem-cal-body\b[^"']*["'][^>]*>([\s\S]*?)(?=<footer|<\/main|id=["']footer|$)/i)?.[1] ??
		html;

	const chunks = scope.split(/(?=<div\b[^>]*\bevent_notes\b)/i);
	for (const body of chunks) {
		if (!/event_notes|event_name/i.test(body)) continue;

		const href =
			body.match(/<a\b[^>]*href=["']([^"']*event_id=\d+[^"']*)["']/i)?.[1] ??
			body.match(/<a\b[^>]*href=["']([^"']*\/shows\/[^"']+)["']/i)?.[1] ??
			null;
		const title =
			stripTags(body.match(/class=["'][^"']*\bevent_name\b[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? "") ||
			stripTags(body.match(/alt=["']([^"']+)["']/i)?.[1] ?? "");
		if (!title || title.length < 2) continue;

		const dateText = stripTags(
			body.match(/class=["'][^"']*\bevent_date\b[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? "",
		);
		const parsed = parseEventDateTime(dateText || body, year);
		if (!parsed) continue;

		const img =
			body.match(
				/<img\b[^>]*(?:wp-post-image|attachment-600|size-600)[^>]*src=["']([^"']+)["']/i,
			)?.[1] ??
			body.match(/src=["']([^"']+)["'][^>]*(?:wp-post-image|attachment-600)/i)?.[1] ??
			body.match(/<img\b[^>]*src=["']([^"']*wp-content\/uploads[^"']+)["']/i)?.[1] ??
			null;

		// Description: visible <p> inside notes (skip empty)
		const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
			.map((p) => stripTags(p[1]))
			.filter((t) => t.length >= 12 && !/^buy tickets$/i.test(t));
		const description = paras.length ? paras.join("\n\n") : null;
		const price = extractPrice(dateText || body);

		const sourceUrl = absUrl(href?.replace(/&amp;/g, "&") ?? null, calendarUrl) ?? calendarUrl;
		const eventId = sourceUrl.match(/event_id=(\d+)/i)?.[1] ?? null;
		const startLocal = `${parsed.ymd} ${parsed.clock}`;

		let startsAt: string;
		try {
			startsAt = localWallTimeToUtcIso(startLocal, timezone);
		} catch {
			continue;
		}

		const sourceEventId = eventId ? `em:${eventId}` : `em:${title.toLowerCase()}|${startLocal}`;
		if (seen.has(sourceEventId)) continue;
		seen.add(sourceEventId);

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: venueName,
				address,
				description,
				image_url: absUrl(img, calendarUrl),
				source_url: sourceUrl,
				source_partner: "events_manager",
				source_event_id: sourceEventId,
				raw_date_text: parsed.raw,
				price_text: price,
				ticket_url: /buy tickets/i.test(body) ? sourceUrl : null,
				confidence: 0.95,
			}),
		);
	}

	return events;
}

/** Parse Browser Run markdown (reliable for Hideout after CF/JS). */
export function parseEventsManagerMarkdown(params: {
	md: string;
	calendarUrl: string;
	year: number;
	venueName: string;
	address?: string | null;
	timezone?: string;
}): PartnerEvent[] {
	const { md, calendarUrl, year, venueName, address = null, timezone = "America/Chicago" } = params;
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	const re =
		/\[!\[([^\]]*)\]\(([^)]+)\)([^\]]*)\]\((https?:\/\/[^)]*hideouttheatre\.com\/shows\/[^)]+|https?:\/\/[^)]+\/shows\/[^)]+)\)/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(md)) !== null) {
		const title = (m[1] || "").trim();
		const image = absUrl(m[2], calendarUrl);
		const body = (m[3] || "").trim();
		let url = m[4].replace(/event%5[Ff]id=/gi, "event_id=").replace(/&amp;/g, "&");
		if (!title) continue;

		const rest = body.replace(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "").trim();
		const parsed = parseEventDateTime(rest, year);
		if (!parsed) continue;

		const price = extractPrice(rest);
		let desc = rest
			.slice(rest.indexOf(parsed.raw) + parsed.raw.length)
			.replace(/^[\s–—\-]*Hideout[^$]{0,80}/i, "")
			.replace(price ?? "", "")
			.replace(/\s+/g, " ")
			.trim();
		if (desc.length < 12) desc = "";

		const startLocal = `${parsed.ymd} ${parsed.clock}`;
		let startsAt: string;
		try {
			startsAt = localWallTimeToUtcIso(startLocal, timezone);
		} catch {
			continue;
		}

		const eventId = url.match(/event_id=(\d+)/i)?.[1] ?? null;
		const sourceEventId = eventId ? `em:${eventId}` : `em:${title.toLowerCase()}|${startLocal}`;
		if (seen.has(sourceEventId)) continue;
		seen.add(sourceEventId);

		const sourceUrl = absUrl(url, calendarUrl) ?? calendarUrl;

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: venueName,
				address,
				description: desc || null,
				image_url: image,
				source_url: sourceUrl,
				source_partner: "events_manager",
				source_event_id: sourceEventId,
				raw_date_text: parsed.raw,
				price_text: price,
				ticket_url: sourceUrl,
				confidence: 0.94,
			}),
		);
	}

	return events;
}

function monthUrls(calendarUrl: string, scrapeDaysAhead: number): string[] {
	const base = calendarUrl.split("?")[0].replace(/\/$/, "") + "/";
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const end = new Date(now.getTime() + scrapeDaysAhead * 864e5);
	const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
	const urls: string[] = [];
	const cursor = new Date(start);
	while (cursor <= endMonth) {
		const mo = cursor.getMonth() + 1;
		const yr = cursor.getFullYear();
		urls.push(`${base}?mo=${mo}&yr=${yr}`);
		cursor.setMonth(cursor.getMonth() + 1);
	}
	// Always include bare calendar URL (current month default)
	if (!urls.includes(base) && !urls.some((u) => u.includes(`mo=${now.getMonth() + 1}&yr=${now.getFullYear()}`))) {
		urls.unshift(calendarUrl);
	}
	return urls;
}

async function fetchMonthContent(
	url: string,
	browser?: CloudflareEnv["BROWSER"],
): Promise<{ html?: string; md?: string }> {
	if (browser) {
		try {
			const html = await renderPageContent(browser, url, {
				gotoOptions: { waitUntil: "networkidle2", timeout: 45000 },
				waitForSelector: { selector: ".event_notes, .em-cal-body, .event_name", timeout: 20000 },
				bestAttempt: true,
			});
			if (html.length > 3000 && /event_notes|event_name|em-cal/i.test(html)) {
				return { html };
			}
		} catch {
			/* try markdown */
		}
		try {
			const md = await renderMarkdown(browser, url);
			if (md.length > 500) return { md };
		} catch {
			/* fall through */
		}
	}
	try {
		const html = await fetchPageText(url);
		if (html.length > 3000 && /event_notes|event_name/i.test(html)) return { html };
	} catch {
		/* empty */
	}
	return {};
}

export async function fetchEventsManagerEvents(params: {
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
	browser?: CloudflareEnv["BROWSER"];
	/** Optional first page HTML already fetched */
	calendarHtml?: string;
}): Promise<PartnerEvent[]> {
	const {
		calendarUrl,
		venueName,
		address = null,
		timezone = "America/Chicago",
		scrapeDaysAhead = 120,
		browser,
		calendarHtml,
	} = params;

	const urls = monthUrls(calendarUrl, scrapeDaysAhead);
	const all: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < urls.length; i++) {
		const url = urls[i]!;
		let html = i === 0 && calendarHtml && /event_notes|em-cal/i.test(calendarHtml) ? calendarHtml : undefined;
		let md: string | undefined;

		if (!html) {
			const fetched = await fetchMonthContent(url, browser);
			html = fetched.html;
			md = fetched.md;
		}

		const { year } = yearMonthFromCalendarUrl(url, html || md || "");
		let monthEvents: PartnerEvent[] = [];
		if (html) {
			monthEvents = parseEventsManagerHtml({
				html,
				calendarUrl: url,
				year,
				venueName,
				address,
				timezone,
			});
		}
		if (monthEvents.length === 0 && md) {
			monthEvents = parseEventsManagerMarkdown({
				md,
				calendarUrl: url,
				year,
				venueName,
				address,
				timezone,
			});
		}

		for (const e of monthEvents) {
			const key = e.source_event_id || `${e.title}|${e.starts_at}`;
			if (seen.has(key)) continue;
			seen.add(key);
			all.push(e);
		}
	}

	const now = Date.now() - 6 * 60 * 60 * 1000;
	const cutoff = Date.now() + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	return all
		.filter((e) => {
			const t = new Date(e.starts_at).getTime();
			return !Number.isNaN(t) && t >= now && t <= cutoff;
		})
		.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
