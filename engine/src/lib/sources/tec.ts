/**
 * The Events Calendar (TEC / tribe-events) — month grid + event detail pages.
 *
 * Primary path: Tribe REST API (`/wp-json/tribe/events/v1/events`) when available
 * (gives exact title, times, image, and full HTML description from the venue).
 *
 * Fallback: crawl `table.tribe-events-calendar-month` event links, visit each
 * `/event/...` detail page (image, .epta-title-date, .epta-content-area, tickets,
 * .tribe-events-meta-group-details), then follow next-month nav chevron.
 */
import { renderPageContent } from "../browser";
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

/**
 * Saxon (and some TEC hosts) WAF-block Cloudflare Worker fetches and Chrome UAs.
 * Order: light-UA fetch → shared fetchPageText → Browser Run content (full HTML).
 */
async function fetchTecText(
	url: string,
	browser?: CloudflareEnv["BROWSER"],
): Promise<string> {
	const isApi = url.includes("/wp-json/");

	try {
		const res = await fetch(url, {
			headers: {
				Accept: isApi ? "application/json" : "text/html,*/*",
				"User-Agent": "Mozilla/5.0 events-platform-tec",
			},
			redirect: "follow",
		});
		if (res.ok) {
			const text = await res.text();
			if (isApi && text.trimStart().startsWith("{")) return text;
			if (!isApi && text.length > 2000 && /tribe-events|epta-title|wp-post-image|\/event\//i.test(text)) {
				return text;
			}
		}
	} catch {
		/* try next */
	}

	if (!isApi) {
		try {
			const text = await fetchPageText(url);
			if (text.length > 2000 && /tribe-events|epta-title|wp-post-image|\/event\//i.test(text)) {
				return text;
			}
		} catch {
			/* try browser */
		}
	}

	if (browser) {
		return renderPageContent(browser, url);
	}

	throw new Error(`Could not fetch TEC URL: ${url}`);
}

export function isTecCalendar(html: string, pageUrl: string): boolean {
	const haystack = `${pageUrl}\n${html}`.toLowerCase();
	return (
		/tribe-events|the-events-calendar|tec-events|tribe_events|tribe\/events\/v1|\/events\/month\//i.test(
			haystack,
		) || /thesaxonpub\.com\/events/i.test(pageUrl)
	);
}

function decodeEntities(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#036;/g, "$");
}

function stripHtml(value: string): string {
	return decodeEntities(value)
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

function absUrl(href: string, base: string): string {
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
}

function localToUtc(local: string, timezone: string): string {
	// local: "2026-07-01 18:00:00" or "2026-07-01T18:00:00"
	const normalized = local.replace("T", " ").trim();
	const match = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?/);
	if (!match) {
		const d = new Date(local);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
		throw new Error(`Invalid local datetime: ${local}`);
	}
	const wall = `${match[1]} ${match[2]}:${match[3] ?? "00"}`;
	return localWallTimeToUtcIso(wall, timezone);
}

interface TribeRestEvent {
	id: number;
	title: string;
	description?: string;
	excerpt?: string;
	url: string;
	start_date: string;
	end_date?: string;
	utc_start_date?: string;
	utc_end_date?: string;
	timezone?: string;
	cost?: string;
	website?: string;
	image?: { url?: string } | false | null;
	ticketed?: boolean;
}

interface TribeRestResponse {
	events?: TribeRestEvent[];
	total?: number;
	total_pages?: number;
	next_rest_url?: string;
}

function tribeApiBase(pageUrl: string): string {
	const origin = new URL(pageUrl).origin;
	return `${origin}/wp-json/tribe/events/v1/events`;
}

async function fetchJsonViaBrowser(
	browser: CloudflareEnv["BROWSER"],
	url: string,
): Promise<string | null> {
	try {
		// Browser can clear SiteGround captcha that blocks Worker fetch.
		const html = await renderPageContent(browser, url);
		const trimmed = html.trim();
		// Some browsers wrap JSON in <pre> or full HTML document
		const pre = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
		const candidate = (pre ?? trimmed).replace(/<[^>]+>/g, "").trim();
		if (candidate.startsWith("{") || candidate.startsWith("[")) return candidate;
		const embedded = trimmed.match(/\{[\s\S]*"events"\s*:\s*\[[\s\S]*\}/);
		if (embedded) return embedded[0];
		return null;
	} catch {
		return null;
	}
}

async function fetchViaRestApi(params: {
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxEvents: number;
	browser?: CloudflareEnv["BROWSER"];
}): Promise<PartnerEvent[] | null> {
	const start = new Date();
	const end = new Date(Date.now() + params.scrapeDaysAhead * 24 * 60 * 60 * 1000);
	const startDate = start.toISOString().slice(0, 10);
	const endDate = end.toISOString().slice(0, 10);

	const events: PartnerEvent[] = [];
	let page = 1;
	// Tribe caps per_page at 50; paginate until exhausted (full venue calendar).
	const perPage = 50;
	const maxPages = Math.max(50, Math.ceil(params.maxEvents / perPage) + 5);

	while (page <= maxPages && events.length < params.maxEvents) {
		const url = new URL(tribeApiBase(params.calendarUrl));
		url.searchParams.set("per_page", String(perPage));
		url.searchParams.set("page", String(page));
		url.searchParams.set("start_date", startDate);
		url.searchParams.set("end_date", endDate);
		url.searchParams.set("status", "publish");

		let json: TribeRestResponse;
		try {
			let text: string | null = null;
			try {
				text = await fetchTecText(url.toString(), undefined);
			} catch {
				text = null;
			}
			if (!text?.trimStart().startsWith("{") && params.browser) {
				text = await fetchJsonViaBrowser(params.browser, url.toString());
			}
			if (!text?.trimStart().startsWith("{")) {
				return page === 1 ? null : events;
			}
			json = JSON.parse(text) as TribeRestResponse;
		} catch {
			return page === 1 ? null : events;
		}

		const batch = json.events ?? [];
		if (batch.length === 0) break;

		for (const row of batch) {
			if (events.length >= params.maxEvents) break;
			try {
				// Always convert local wall time (start_date + venue TZ). Using utc_start_date
				// as a calendar date alone looks one day late for evening shows (e.g. 8pm
				// CDT = 01:00 next day UTC).
				const tz = row.timezone || params.timezone || "America/Chicago";
				const startsAt = localToUtc(row.start_date, tz);
				const endsAt = row.end_date ? localToUtc(row.end_date, tz) : null;

				const descriptionHtml = row.description || row.excerpt || "";
				const description = stripHtml(descriptionHtml) || null;
				const imageUrl =
					row.image && typeof row.image === "object" ? (row.image.url ?? null) : null;
				const cost = stripHtml((row.cost ?? "").trim());
				const priceText = cost
					? cost.toLowerCase() === "free" || cost === "0"
						? "Free"
						: cost.startsWith("$")
							? cost
							: `$${cost.replace(/^\$/, "")}`
					: null;
				const ticketUrl = (row.website ?? "").trim() || row.url;

				events.push(
					toPartnerEvent({
						title: stripHtml(row.title),
						starts_at: startsAt,
						ends_at: endsAt,
						venue_name: params.venueName,
						address: params.address,
						description,
						image_url: imageUrl,
						source_url: row.url,
						source_partner: "tec",
						source_event_id: String(row.id),
						raw_date_text: row.start_date,
						price_text: priceText,
						ticket_url: ticketUrl,
						confidence: 0.95,
					}),
				);
			} catch {
				// skip bad row
			}
		}

		const totalPages = json.total_pages ?? page;
		if (page >= totalPages || batch.length < perPage) break;
		page++;
	}

	return events.length > 0 ? events : null;
}

/** Extract unique /event/ links from a TEC month grid page. */
export function extractTecEventLinks(html: string, pageUrl: string): string[] {
	const links = new Set<string>();
	const patterns = [
		/href="(https?:\/\/[^"]+\/event\/[^"#?]+(?:\/\d{4}-\d{2}-\d{2}\/)?)"/gi,
		/href="(\/event\/[^"#?]+(?:\/\d{4}-\d{2}-\d{2}\/)?)"/gi,
		/class="tribe-events-calendar-month__calendar-event-title-link[^"]*"[^>]*href="([^"]+)"/gi,
		/href="([^"]+)"[^>]*class="[^"]*tribe-events-calendar-month__calendar-event-title-link[^"]*"/gi,
		// Carousel Lounge uses /calendar/{slug}/ event permalinks (not /event/)
		/href="(https?:\/\/[^"]+\/calendar\/[^"#?]+\/)"[^>]*title="/gi,
		/href="(\/calendar\/[^"#?]+\/)"[^>]*title="/gi,
	];
	for (const re of patterns) {
		for (const match of html.matchAll(re)) {
			const href = match[1];
			// Accept classic /event/ and TEC /calendar/{slug}/ detail pages
			if (!/\/event\//i.test(href) && !/\/calendar\/[^/]+\/?$/i.test(href)) continue;
			if (/\/calendar\/month\//i.test(href)) continue;
			if (/\/calendar\/\d{4}-\d{2}/i.test(href)) continue;
			if (/[?&]ical=1/i.test(href)) continue;
			links.add(absUrl(href, pageUrl).replace(/\/$/, "") + "/");
		}
	}
	return [...links];
}

export function extractTecNextMonthUrl(html: string, pageUrl: string): string | null {
	const patterns = [
		/href="([^"]+)"[^>]*class="[^"]*tribe-events-c-nav__next[^"]*"/i,
		/class="[^"]*tribe-events-c-nav__next[^"]*"[^>]*href="([^"]+)"/i,
		// Carousel Lounge elementor embed: caret-right next month link
		/href="([^"]+)"[^>]*title="Next month[^"]*"/i,
		/title="Next month[^"]*"[^>]*href="([^"]+)"/i,
		/href="([^"]*\/events\/month\/\d{4}-\d{2}\/?[^"]*)"/i,
		// /calendar/month/YYYY-MM/ (Carousel + some TEC shortcode embeds)
		/href="([^"]*\/calendar\/month\/\d{4}-\d{2}\/?[^"]*)"/i,
	];
	for (const re of patterns) {
		const m = html.match(re);
		if (m?.[1] && !/disabled|aria-disabled="true"/i.test(m[0])) {
			return absUrl(m[1], pageUrl);
		}
	}
	return null;
}

/** Parse a single TEC event detail page (Saxon-style epta theme fields). */
export function parseTecEventDetailPage(
	html: string,
	pageUrl: string,
	venueName: string,
	address: string | null,
	timezone: string,
): PartnerEvent | null {
	const titleDateBlock =
		html.match(/class="epta-title-date"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
		html.match(/class="tribe-events-single-event-title"[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1] ??
		"";
	const titleDateText = stripHtml(titleDateBlock);
	// e.g. "West Texas Exiles June 29 @ 6:00 pm - 7:30 pm"
	const titleMatch = titleDateText.match(
		/^(.+?)\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:\s*@.*)?)$/i,
	);
	const ogTitle =
		html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] ??
		html.match(/<h1[^>]*class="[^"]*tribe-events-single-event-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
		html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	let title = (titleMatch?.[1] ?? stripHtml(ogTitle ?? "")).trim();
	// og:title sometimes "Event Name – The Saxon Pub"
	title = title.replace(/\s+[–|-]\s+The Saxon Pub.*$/i, "").trim();
	if (!title) return null;

	const contentHtml =
		html.match(/class="epta-content-area"[^>]*>([\s\S]*?)(?:<\/div>\s*<div class="epta-|<\/div>\s*<div class="tribe-)/i)?.[1] ??
		html.match(/class="tribe-events-single-event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
		html.match(/class="tribe-events-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
		html.match(/class="entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
		"";
	const description = stripHtml(contentHtml) || null;

	// Flamingo / block themes often use wp-image-* instead of wp-post-image
	const rawImg =
		html.match(/class="[^"]*wp-post-image[^"]*"[^>]*src="([^"]+)"/i)?.[1] ??
		html.match(/src="([^"]+)"[^>]*class="[^"]*wp-post-image[^"]*"/i)?.[1] ??
		html.match(/class="[^"]*wp-image-\d+[^"]*"[^>]*src="([^"]+)"/i)?.[1] ??
		html.match(/src="([^"]+)"[^>]*class="[^"]*wp-image-\d+/i)?.[1] ??
		html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ??
		null;
	const img = rawImg
		? String(rawImg)
				.replace(/^http:\/\//i, "https://")
				.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, "$1")
		: null;

	const details =
		html.match(/tribe-events-meta-group-details[\s\S]{0,2500}/i)?.[0] ?? "";
	const detailsText = stripHtml(details);

	// Prefer JSON-LD startDate (Flamingo Cantina etc.) then tribe datetime attrs
	const jsonLdStart = html.match(/"startDate"\s*:\s*"([^"]+)"/i)?.[1];
	const jsonLdEnd = html.match(/"endDate"\s*:\s*"([^"]+)"/i)?.[1];
	const datetimeStart =
		jsonLdStart ??
		html.match(/datetime="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^"]*)"/i)?.[1] ??
		html.match(/tribe-event-date-start[^>]*datetime="([^"]+)"/i)?.[1];
	const datetimeEnd =
		jsonLdEnd ?? html.match(/tribe-event-date-end[^>]*datetime="([^"]+)"/i)?.[1];

	let startsAt: string | null = null;
	let endsAt: string | null = null;

	if (datetimeStart) {
		const d = new Date(datetimeStart);
		if (!Number.isNaN(d.getTime())) startsAt = d.toISOString();
	}
	if (datetimeEnd) {
		const d = new Date(datetimeEnd);
		if (!Number.isNaN(d.getTime())) endsAt = d.toISOString();
	}

	// Fallback: parse "June 29 @ 6:00 pm - 7:30 pm" with year from URL or page
	if (!startsAt) {
		const year =
			pageUrl.match(/\/(\d{4})-\d{2}-\d{2}\//)?.[1] ??
			html.match(/datetime="(\d{4})-/i)?.[1] ??
			String(new Date().getFullYear());
		const m = titleDateText.match(
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)/i,
		);
		if (m) {
			const months: Record<string, string> = {
				january: "01",
				february: "02",
				march: "03",
				april: "04",
				may: "05",
				june: "06",
				july: "07",
				august: "08",
				september: "09",
				october: "10",
				november: "11",
				december: "12",
			};
			const mon = months[m[1].toLowerCase()];
			let hour = Number(m[3]);
			const min = m[4];
			const ap = m[5].toLowerCase();
			if (ap === "pm" && hour < 12) hour += 12;
			if (ap === "am" && hour === 12) hour = 0;
			const wall = `${year}-${mon}-${m[2].padStart(2, "0")} ${String(hour).padStart(2, "0")}:${min}:00`;
			try {
				startsAt = localToUtc(wall, timezone);
			} catch {
				/* ignore */
			}
		}
	}

	if (!startsAt) return null;

	const costMatch =
		detailsText.match(/Cost:\s*(\$?[\d,.]+|Free)/i) ??
		html.match(/tribe-events-cost[^>]*>([\s\S]*?)<\//i);
	const priceText = costMatch ? stripHtml(costMatch[1]).trim() : null;

	const ticketLink =
		html.match(/href="([^"]+)"[^>]*class="[^"]*tribe-tickets[^"]*"/i)?.[1] ??
		html.match(/class="[^"]*tribe-tickets__buy[^"]*"[^>]*href="([^"]+)"/i)?.[1] ??
		null;

	const youtubeId =
		html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i)?.[1] ??
		html.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i)?.[1] ??
		html.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i)?.[1] ??
		html.match(/data-(?:video-)?id="([a-zA-Z0-9_-]{11})"/i)?.[1] ??
		null;

	const sourceEventId =
		html.match(/postid-(\d+)/i)?.[1] ??
		html.match(/data-event-id="(\d+)"/i)?.[1] ??
		pageUrl;

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		ends_at: endsAt,
		venue_name: venueName,
		address,
		description,
		image_url: img,
		source_url: pageUrl,
		source_partner: "tec",
		source_event_id: String(sourceEventId),
		raw_date_text: titleDateText || detailsText.slice(0, 120),
		price_text: priceText,
		ticket_url: ticketLink ? absUrl(ticketLink, pageUrl) : pageUrl,
		confidence: 0.9,
		youtube_id: youtubeId,
		youtube_embed: youtubeId
			? `<iframe width="560" height="315" src="https://www.youtube.com/embed/${youtubeId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`
			: null,
	});
}

async function fetchViaMonthCrawl(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxEvents: number;
	browser?: CloudflareEnv["BROWSER"];
}): Promise<PartnerEvent[]> {
	const cutoff = Date.now() + params.scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const seen = new Set<string>();
	const eventUrls: string[] = [];

	// SiteGround captcha blocks Worker fetch — prefer Browser Run for Saxon-style hosts.
	let monthHtml = params.calendarHtml;
	let monthUrl = params.calendarUrl;
	if (params.browser) {
		try {
			monthHtml = await renderPageContent(params.browser, params.calendarUrl);
		} catch {
			if (!/tribe-events|\/event\//i.test(monthHtml)) {
				monthHtml = await fetchTecText(params.calendarUrl, params.browser);
			}
		}
	} else if (!/tribe-events-calendar-month|\/event\//i.test(monthHtml)) {
		monthHtml = await fetchTecText(params.calendarUrl);
	}

	// Follow next-month chevron/caret until scrapeDaysAhead window is covered
	// (Carousel / elementor embeds may list 5–6+ months out).
	const maxMonths = Math.min(14, Math.ceil(params.scrapeDaysAhead / 28) + 2);

	for (let m = 0; m < maxMonths; m++) {
		const links = extractTecEventLinks(monthHtml, monthUrl);
		for (const link of links) {
			const fullKey = link.replace(/\/$/, "");
			if (seen.has(fullKey)) continue;
			seen.add(fullKey);
			eventUrls.push(link.endsWith("/") ? link : `${link}/`);
		}
		const next = extractTecNextMonthUrl(monthHtml, monthUrl);
		if (!next || next === monthUrl) break;
		try {
			monthHtml = params.browser
				? await renderPageContent(params.browser, next)
				: await fetchTecText(next, params.browser);
			monthUrl = next;
		} catch {
			break;
		}
	}

	const events: PartnerEvent[] = [];
	// Browser detail pages are slow; cap for pilot reliability
	const toFetch = eventUrls.slice(0, Math.min(params.maxEvents, 15));
	for (const eventUrl of toFetch) {
		if (events.length >= params.maxEvents) break;
		try {
			const detailHtml = params.browser
				? await renderPageContent(params.browser, eventUrl)
				: await fetchTecText(eventUrl, params.browser);
			const parsed = parseTecEventDetailPage(
				detailHtml,
				eventUrl,
				params.venueName,
				params.address,
				params.timezone,
			);
			if (!parsed) continue;
			if (new Date(parsed.starts_at).getTime() > cutoff) continue;
			const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
			if (new Date(parsed.starts_at).getTime() < oneDayAgo) continue;
			events.push(parsed);
		} catch {
			// skip failed detail
		}
	}

	return events;
}

export async function fetchTecEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	maxEvents?: number;
	browser?: CloudflareEnv["BROWSER"];
}): Promise<PartnerEvent[]> {
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 400; // ~13 months — full published calendar
	const maxEvents = params.maxEvents ?? 500;

	// 1) Tribe REST — exact descriptions from the venue CMS (when not WAF-blocked)
	const fromApi = await fetchViaRestApi({
		calendarUrl: params.calendarUrl,
		venueName: params.venueName,
		address: params.address,
		timezone: params.timezone,
		scrapeDaysAhead,
		maxEvents,
		browser: params.browser,
	});
	if (fromApi && fromApi.length > 0) return fromApi;

	// 2) Month grid → each event detail page (agent workflow you described)
	return fetchViaMonthCrawl({
		calendarHtml: params.calendarHtml,
		calendarUrl: params.calendarUrl,
		venueName: params.venueName,
		address: params.address,
		timezone: params.timezone,
		scrapeDaysAhead,
		maxEvents,
		browser: params.browser,
	});
}
