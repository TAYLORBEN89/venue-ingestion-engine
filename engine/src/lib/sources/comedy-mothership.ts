/**
 * Comedy Mothership (comedymothership.com/shows)
 *
 * Next.js grid of show cards (CSS modules). Walkthrough (admin pilot):
 * 1. Grid: ol[class*="EventCardGrid_eventCardGrid"]
 * 2. Card: div[class*="EventCard_eventCard"] (data-event-topics optional)
 * 3. Image: img (often /_next/image?url=…filepicker…); prefer decoded CDN URL
 * 4. Date + title: [class*="EventCard_titleWrapper"]
 * 5. Details list: [class*="EventCard_detailsWrapper"]
 *    → start–end time, FAT MAN | LITTLE BOY, seating notes
 * 6. Description (generic): "{title} at {time of show} on the {Fat Man|Little Boy} stage."
 * 7. Pagination: a[href="?page=N"] — crawl every page
 *
 * Vercel bot protection returns Security Checkpoint on bare fetch; production
 * ingest uses Browser Rendering. Local pilots can pass pre-rendered HTML.
 */
import { renderPageContent } from "../browser";
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";

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

const ROOM_LABELS: Record<string, string> = {
	"fat man": "Fat Man",
	"little boy": "Little Boy",
};

export function isComedyMothership(pageUrl: string, html = ""): boolean {
	if (/comedymothership\.com/i.test(pageUrl)) return true;
	return (
		/EventCardGrid_eventCardGrid|EventCard_eventCard__/i.test(html) &&
		/FAT MAN|LITTLE BOY|Comedy Mothership/i.test(html)
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

function isCheckpoint(html: string): boolean {
	return /Vercel Security Checkpoint|We're verifying your browser/i.test(html);
}

/** Unwrap Next.js image optimizer → original CDN URL when present. */
export function resolveImageUrl(src: string | null | undefined): string | null {
	if (!src) return null;
	const raw = decodeEntities(src.trim());
	if (!raw) return null;
	try {
		if (raw.includes("/_next/image")) {
			const u = new URL(raw, "https://comedymothership.com");
			const target = u.searchParams.get("url");
			if (target) return decodeURIComponent(target);
		}
	} catch {
		/* keep raw */
	}
	if (raw.startsWith("//")) return `https:${raw}`;
	if (raw.startsWith("/")) return `https://comedymothership.com${raw}`;
	return raw;
}

function parseClock(text: string): { hour: number; minute: number; label: string } | null {
	const m = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!m) return null;
	let hour = Number(m[1]) % 12;
	if (m[3].toLowerCase() === "pm") hour += 12;
	const minute = Number(m[2]);
	const label = `${Number(m[1])}:${m[2]} ${m[3].toUpperCase()}`;
	return { hour, minute, label };
}

function parseEndClock(text: string): { hour: number; minute: number } | null {
	// "7:00 PM - 9:00 PM" or "10:00 PM - 12:00 AM"
	const m = text.match(
		/\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(am|pm)/i,
	);
	if (!m) return null;
	let hour = Number(m[1]) % 12;
	if (m[3].toLowerCase() === "pm") hour += 12;
	return { hour, minute: Number(m[2]) };
}

/** "Wednesday, Jul 22" / "Sat, August 1" — year inferred from "now". */
export function parseListingDate(text: string, now = new Date()): { y: number; m: number; d: number } | null {
	const m = text.match(
		/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
	);
	if (!m) {
		const m2 = text.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
		if (!m2) return null;
		const mon = MONTHS[m2[1].toLowerCase()];
		if (!mon) return null;
		const d = Number(m2[2]);
		const y = m2[3] ? Number(m2[3]) : resolveYear(mon, d, now);
		return { y, m: mon, d };
	}
	const mon = MONTHS[m[1].toLowerCase()];
	if (!mon) return null;
	const d = Number(m[2]);
	const y = m[3] ? Number(m[3]) : resolveYear(mon, d, now);
	return { y, m: mon, d };
}

function resolveYear(month: number, day: number, now: Date): number {
	const y = now.getFullYear();
	const curM = now.getMonth() + 1;
	const curD = now.getDate();
	// Listing months clearly behind → next calendar year
	if (month < curM - 1) return y + 1;
	if (month === curM && day + 1 < curD && curM >= 11) return y + 1;
	if (month < curM || (month === curM && day < curD - 2)) {
		// Past dates late in the year may still be same-year archive on page 1 — keep year
		if (curM <= 2 && month >= 11) return y - 1;
	}
	return y;
}

function normalizeRoom(raw: string | null): string | null {
	if (!raw) return null;
	const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
	if (ROOM_LABELS[key]) return ROOM_LABELS[key];
	if (/fat\s*man/i.test(raw)) return "Fat Man";
	if (/little\s*boy/i.test(raw)) return "Little Boy";
	return null;
}

function buildDescription(title: string, timeLabel: string, room: string | null): string {
	const stage = room ? `${room} stage` : "stage";
	return `${title} at ${timeLabel} on the ${stage}.`;
}

export type MothershipCard = {
	title: string;
	dateText: string;
	starts_at: string;
	ends_at: string | null;
	room: string | null;
	image_url: string | null;
	source_url: string;
	source_event_id: string | null;
	ticket_url: string | null;
	raw_date_text: string;
	price_text: string | null;
	description: string;
	sold_out: boolean;
};

/**
 * Parse one hydrated /shows HTML page into cards.
 * CSS module hashes change; match on stable prefixes + structure.
 */
export function parseComedyMothershipPage(
	html: string,
	pageUrl: string,
	timezone: string,
	now = new Date(),
): MothershipCard[] {
	if (isCheckpoint(html)) return [];

	const base = new URL(pageUrl);
	const origin = base.origin;
	const out: MothershipCard[] = [];

	// Split on card roots (hashed class or data-event-topics)
	const parts = html.split(
		/(?=<div[^>]+class="[^"]*EventCard_eventCard__[^"]*"|<div[^>]+data-event-topics=)/i,
	);

	for (const chunk of parts) {
		if (!/EventCard_eventCard__|data-event-topics=/i.test(chunk.slice(0, 200))) continue;
		// Bound chunk roughly to one card
		const cardHtml = chunk.slice(0, 8000);

		const showHref =
			cardHtml.match(/href=["'](\/shows\/\d+[^"']*)["']/i)?.[1] ??
			cardHtml.match(/href=["'](https:\/\/comedymothership\.com\/shows\/\d+[^"']*)["']/i)?.[1] ??
			null;
		const sourcePath = showHref
			? showHref.startsWith("http")
				? showHref
				: `${origin}${showHref}`
			: pageUrl;
		const eventId = sourcePath.match(/\/shows\/(\d+)/)?.[1] ?? null;

		const imgSrc =
			cardHtml.match(
				/<img[^>]+srcset=["']([^"']*cdn\.filepicker\.io[^"']*|[^"']*\/_next\/image\?url=[^"']+)["']/i,
			)?.[1]
				?.split(/\s+/)[0] ??
			cardHtml.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ??
			null;
		// Prefer first URL in srcset before density descriptor
		const image_url = resolveImageUrl(
			imgSrc?.includes(" ") ? imgSrc.split(/\s+/)[0] : imgSrc,
		);
		// 2x srcset may encode better; also try url= param from any next/image in card
		const nextUrl =
			cardHtml.match(/\/_next\/image\?url=([^&"'\s]+)/i)?.[1] ??
			cardHtml.match(/url=(https?%3A%2F%2Fcdn\.filepicker\.io[^&"'\s]+)/i)?.[1];
		const imageFromNext = nextUrl ? resolveImageUrl(`/_next/image?url=${nextUrl}`) : null;
		const finalImage = imageFromNext ?? image_url;

		const titleFromAlt =
			cardHtml.match(/<img[^>]+alt=["']([^"']+)["']/i)?.[1]?.trim() ?? null;

		const titleBlock =
			cardHtml.match(
				/class="[^"]*EventCard_titleWrapper__[^"]*"[^>]*>([\s\S]*?)<(?:ul|div)[^>]*class="[^"]*EventCard_details/i,
			)?.[1] ??
			cardHtml.match(
				/class="[^"]*EventCard_titleWrapper__[^"]*"[^>]*>([\s\S]{0,800}?)<\/div>/i,
			)?.[1] ??
			"";

		const detailsBlock =
			cardHtml.match(
				/class="[^"]*EventCard_detailsWrapper__[^"]*"[^>]*>([\s\S]*?)<\/ul>/i,
			)?.[1] ?? "";

		const titleText = stripHtml(titleBlock);
		const detailsText = stripHtml(detailsBlock);
		const combined = `${titleText} ${detailsText}`;

		// Date line often "Wednesday, Jul 22" at start of title wrapper
		const dateMatch = combined.match(
			/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+[A-Za-z]{3,9}\s+\d{1,2}(?:,?\s*\d{4})?/i,
		);
		const dateText = dateMatch?.[0] ?? "";
		const parsedDate = parseListingDate(dateText || combined, now);
		if (!parsedDate) continue;

		// Title: alt, or text after date in title wrapper
		let title =
			(titleFromAlt && titleFromAlt.length > 1 ? decodeEntities(titleFromAlt) : null) ??
			null;
		if (!title) {
			const afterDate = titleText
				.replace(dateMatch?.[0] ?? "", " ")
				.replace(/\s+/g, " ")
				.trim();
			title = afterDate
				.split(/\s{2,}|\n/)
				.map((s) => s.trim())
				.find((s) => s.length > 2 && !/^(sold out|buy tickets)$/i.test(s)) ?? null;
		}
		if (!title) {
			// fallback: longest non-date token sequence
			title =
				titleText
					.replace(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+[A-Za-z]{3,9}\s+\d{1,2}/i, "")
					.replace(/\s+/g, " ")
					.trim() || null;
		}
		if (!title || title.length < 2) continue;
		title = title.replace(/\*+\s*$/, "").trim();

		const timeRange =
			combined.match(
				/(\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–—]\s*\d{1,2}:\d{2}\s*(?:am|pm))/i,
			)?.[1] ??
			combined.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i)?.[1] ??
			null;
		const startClock = timeRange ? parseClock(timeRange) : null;
		if (!startClock) continue;
		const endClock = timeRange ? parseEndClock(timeRange) : null;

		const roomRaw =
			detailsText.match(/\bFAT\s*MAN\b/i)?.[0] ??
			detailsText.match(/\bLITTLE\s*BOY\b/i)?.[0] ??
			combined.match(/\bFAT\s*MAN\b/i)?.[0] ??
			combined.match(/\bLITTLE\s*BOY\b/i)?.[0] ??
			null;
		const room = normalizeRoom(roomRaw);

		const ymd = `${parsedDate.y}-${String(parsedDate.m).padStart(2, "0")}-${String(parsedDate.d).padStart(2, "0")}`;
		const wallStart = `${ymd} ${String(startClock.hour).padStart(2, "0")}:${String(startClock.minute).padStart(2, "0")}:00`;
		let starts_at: string;
		try {
			starts_at = localWallTimeToUtcIso(wallStart, timezone);
		} catch {
			continue;
		}

		let ends_at: string | null = null;
		if (endClock) {
			let endYmd = ymd;
			// Cross midnight (e.g. 10pm–12am)
			if (
				endClock.hour < startClock.hour ||
				(endClock.hour === startClock.hour && endClock.minute < startClock.minute)
			) {
				const next = new Date(
					Date.UTC(parsedDate.y, parsedDate.m - 1, parsedDate.d + 1),
				);
				endYmd = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
			}
			const wallEnd = `${endYmd} ${String(endClock.hour).padStart(2, "0")}:${String(endClock.minute).padStart(2, "0")}:00`;
			try {
				ends_at = localWallTimeToUtcIso(wallEnd, timezone);
			} catch {
				ends_at = null;
			}
		}

		const sold_out = /sold\s*out/i.test(cardHtml);
		const seatingBits: string[] = [];
		if (/general\s*admission/i.test(combined)) seatingBits.push("General Admission");
		if (/booth\s*seating/i.test(combined)) seatingBits.push("Booth Seating");
		if (sold_out) seatingBits.push("Sold Out");

		const ticket_url = sold_out ? null : sourcePath;

		out.push({
			title,
			dateText,
			starts_at,
			ends_at,
			room,
			image_url: finalImage,
			source_url: sourcePath,
			source_event_id: eventId,
			ticket_url,
			raw_date_text: `${dateText} ${timeRange ?? startClock.label}`.trim(),
			price_text: seatingBits.length ? seatingBits.join(" · ") : null,
			description: buildDescription(title, startClock.label, room),
			sold_out,
		});
	}

	return out;
}

/** Collect pagination page numbers from listing HTML. */
export function extractMothershipPageNumbers(html: string): number[] {
	const pages = new Set<number>([1]);
	for (const m of html.matchAll(/[?&]page=(\d+)/gi)) {
		const n = Number(m[1]);
		if (Number.isFinite(n) && n >= 1 && n <= 50) pages.add(n);
	}
	// Numbered pagination links with only the digit as text are hard to regex;
	// also catch Pagination_paginationLink hrefs.
	for (const m of html.matchAll(
		/Pagination_paginationLink[^>]*>\s*(\d+)\s*</gi,
	)) {
		const n = Number(m[1]);
		if (Number.isFinite(n) && n >= 1 && n <= 50) pages.add(n);
	}
	return [...pages].sort((a, b) => a - b);
}

function showsListUrl(calendarUrl: string, page: number): string {
	const u = new URL(calendarUrl);
	// Normalize to /shows listing
	if (!/\/shows/i.test(u.pathname) || /\/shows\/\d+/.test(u.pathname)) {
		u.pathname = "/shows";
	}
	if (page <= 1) {
		u.searchParams.delete("page");
	} else {
		u.searchParams.set("page", String(page));
	}
	return u.toString();
}

async function loadPageHtml(
	url: string,
	browser: CloudflareEnv["BROWSER"] | undefined,
	seedHtml?: string | null,
): Promise<string> {
	if (seedHtml && !isCheckpoint(seedHtml) && /EventCard/i.test(seedHtml)) {
		return seedHtml;
	}
	if (browser) {
		return renderPageContent(browser, url, {
			gotoOptions: { waitUntil: "networkidle2", timeout: 45000 },
			waitForSelector: {
				selector:
					'[class*="EventCard_eventCard"], [class*="EventCardGrid_eventCardGrid"], [data-event-topics]',
				timeout: 25000,
			},
			bestAttempt: true,
		});
	}
	// Bare fetch often hits Vercel checkpoint — still try for non-prod fixtures
	const res = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
			Accept: "text/html",
		},
		redirect: "follow",
	});
	const text = await res.text();
	if (isCheckpoint(text)) {
		throw new Error(
			`Comedy Mothership blocked bare fetch (Vercel Security Checkpoint). Use Browser Rendering for ${url}`,
		);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return text;
}

export async function fetchComedyMothershipEvents(params: {
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	maxPages?: number;
	browser?: CloudflareEnv["BROWSER"];
	/** Optional first-page HTML (tests / when already fetched). */
	calendarHtml?: string | null;
}): Promise<PartnerEvent[]> {
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 120;
	const maxPages = params.maxPages ?? 12;
	const timezone = params.timezone || "America/Chicago";
	const now = new Date();
	const horizon = Date.now() + scrapeDaysAhead * 864e5;
	const floor = Date.now() - 2 * 3600e3;

	const firstUrl = showsListUrl(params.calendarUrl, 1);
	const firstHtml = await loadPageHtml(
		firstUrl,
		params.browser,
		params.calendarHtml,
	);

	const foundPages = extractMothershipPageNumbers(firstHtml).filter((p) => p <= maxPages);
	const maxPage = foundPages.length ? Math.max(...foundPages) : 1;
	// Contiguous 1..max — pagination markup often only links page 1,2,…,N
	const pagesToFetch = Array.from(
		{ length: Math.min(maxPage, maxPages) },
		(_, i) => i + 1,
	);

	const cards: MothershipCard[] = [];
	const seen = new Set<string>();

	for (const page of pagesToFetch) {
		const url = showsListUrl(params.calendarUrl, page);
		const html =
			page === 1
				? firstHtml
				: await loadPageHtml(url, params.browser, null);
		const parsed = parseComedyMothershipPage(html, url, timezone, now);
		for (const c of parsed) {
			const key =
				c.source_event_id ??
				`${c.title.toLowerCase()}|${c.starts_at}|${c.room ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			cards.push(c);
		}
	}

	const events: PartnerEvent[] = [];
	for (const c of cards) {
		const t = new Date(c.starts_at).getTime();
		if (!Number.isFinite(t) || t < floor || t > horizon) continue;
		events.push(
			toPartnerEvent({
				title: c.title,
				starts_at: c.starts_at,
				ends_at: c.ends_at,
				venue_name: params.venueName,
				address: params.address,
				description: c.description,
				image_url: c.image_url,
				source_url: c.source_url,
				source_partner: "comedy_mothership",
				source_event_id: c.source_event_id,
				raw_date_text: c.raw_date_text,
				price_text: c.price_text,
				ticket_url: c.ticket_url,
				confidence: c.source_event_id ? 0.95 : 0.85,
			}),
		);
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}
