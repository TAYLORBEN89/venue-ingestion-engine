/**
 * ACE Calendar / ACE Commerce (ZACH Theatre and similar).
 *
 * User path for zachtheater.org:
 *   Calendar LIST: /calendar/?date=YYYY-MM-DD&layout=B  (A=mini, B=LIST, C=grid)
 *     → li.ace-cal-list-day → article.ace-cal-list-event-content
 *     → h4.ace-cal-list-event-name + a.btn[href*="smartseat"] Get Tickets
 *     → detail PDP for image + description
 *
 * In practice the calendar LIST SPA loads events from /ace-api/events/ which is
 * Incapsula-protected and often returns empty under Browser Run. Production
 * detail pages (/tickets/pdps/…) *do* render the full performance schedule:
 *   li.ace-production-row… + .subtitle-text date/time + smartseat?itemNumber=
 *
 * Strategy:
 *   1. Try LIST calendar HTML (if browser already has cards).
 *   2. Discover production PDPs from /tickets/shows/ + calendar shell links.
 *   3. Browser-render each PDP → parse performances + hero image + description.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { renderPageContent } from "../browser";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

const MONTH_INDEX: Record<string, number> = {
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

export function isAceCalendar(html: string, pageUrl: string): boolean {
	const hay = `${pageUrl}\n${html}`;
	return (
		/ace-calendar\.js|ace-api\/events|ace-cal-list-|calendarKeyword|ace-production-row/i.test(
			hay,
		) ||
		/zachtheater\.org/i.test(pageUrl) ||
		/zachtheatre\.org/i.test(pageUrl)
	);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/g, "'")
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

function absoluteUrl(href: string, base: string): string {
	try {
		return new URL(href, base).href;
	} catch {
		return href;
	}
}

function siteOrigin(calendarUrl: string): string {
	try {
		const u = new URL(calendarUrl);
		if (/zachtheatre\.org/i.test(u.hostname)) {
			return "https://www.zachtheater.org";
		}
		return u.origin;
	} catch {
		return "https://www.zachtheater.org";
	}
}

function cleanImageUrl(src: string | null | undefined, base: string): string | null {
	if (!src) return null;
	const abs = absoluteUrl(src.replace(/&amp;/g, "&"), base);
	try {
		const u = new URL(abs);
		if (u.pathname.includes("/media/")) {
			u.searchParams.delete("mode");
			u.searchParams.delete("height");
			if (!u.searchParams.has("width")) u.searchParams.set("width", "1440");
			if (!u.searchParams.has("quality")) u.searchParams.set("quality", "75");
			return u.href;
		}
		return abs;
	} catch {
		return abs;
	}
}

function parseClock(text: string): string | null {
	const m = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!m) return null;
	let hour = Number(m[1]) % 12;
	if (m[3].toLowerCase() === "pm") hour += 12;
	return `${String(hour).padStart(2, "0")}:${m[2]}:00`;
}

function parseProseDate(text: string): string | null {
	// "Sunday, July 12th 2026" / "July 12, 2026" / "August 02, 2026"
	const m = text.match(
		/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?,?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
	);
	if (!m) return null;
	const month = MONTH_INDEX[m[1].toLowerCase()];
	if (!month) return null;
	const day = Number(m[2]);
	const year = Number(m[3]);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function ymdFromDataDate(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function extractAttr(tag: string, name: string): string | null {
	const re = new RegExp(`${name}=["']([^"']+)["']`, "i");
	return tag.match(re)?.[1] ?? null;
}

interface AcePerformance {
	title: string;
	ymd: string;
	clock: string;
	rawDateText: string;
	ticketUrl: string | null;
	itemNumber: string | null;
	detailUrl: string;
	imageUrl: string | null;
	description: string | null;
	location: string | null;
}

/** LIST view cards (layout=B) — used when SPA successfully hydrates. */
export function parseAceListHtml(html: string, pageUrl: string): AcePerformance[] {
	const origin = new URL(pageUrl).origin;
	const events: AcePerformance[] = [];

	const dayRe = /<li\b[^>]*class="[^"]*\bace-cal-list-day\b[^"]*"[^>]*>/gi;
	const dayStarts: { index: number; tag: string }[] = [];
	let dm: RegExpExecArray | null;
	while ((dm = dayRe.exec(html)) !== null) {
		dayStarts.push({ index: dm.index, tag: dm[0] });
	}

	const dayChunks: { ymd: string | null; html: string }[] = [];
	if (dayStarts.length > 0) {
		for (let i = 0; i < dayStarts.length; i++) {
			const start = dayStarts[i].index;
			const end =
				i + 1 < dayStarts.length ? dayStarts[i + 1].index : Math.min(html.length, start + 80_000);
			const chunk = html.slice(start, end);
			const ymd =
				ymdFromDataDate(extractAttr(dayStarts[i].tag, "data-date")) ||
				ymdFromDataDate(extractAttr(dayStarts[i].tag, "data-date-key")) ||
				ymdFromDataDate(chunk.match(/id=["']Date_(\d{4}-\d{2}-\d{2})["']/i)?.[1]);
			dayChunks.push({ ymd, html: chunk });
		}
	} else {
		dayChunks.push({ ymd: null, html });
	}

	for (const day of dayChunks) {
		const articleRe = /<article\b[^>]*class="[^"]*\bace-cal-list-event-content\b[^"]*"[^>]*>/gi;
		const starts: number[] = [];
		let am: RegExpExecArray | null;
		while ((am = articleRe.exec(day.html)) !== null) starts.push(am.index);
		const pieces: string[] = [];
		for (let i = 0; i < starts.length; i++) {
			const start = starts[i];
			const end = i + 1 < starts.length ? starts[i + 1] : Math.min(day.html.length, start + 12_000);
			pieces.push(day.html.slice(start, end));
		}

		for (const piece of pieces) {
			const nameBlock =
				piece.match(
					/<h4\b[^>]*class="[^"]*\bace-cal-list-event-name\b[^"]*"[^>]*>([\s\S]*?)<\/h4>/i,
				)?.[1] ?? null;
			if (!nameBlock) continue;
			const title = stripTags(nameBlock);
			if (!title) continue;

			const detailHref =
				nameBlock.match(/href=["']([^"']+)["']/i)?.[1] ??
				piece.match(/href=["']([^"']*\/tickets\/pdps\/[^"']+)["']/i)?.[1] ??
				null;

			const timeText = stripTags(
				piece.match(
					/<p\b[^>]*class="[^"]*\bace-cal-list-event-time\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
				)?.[1] ?? "",
			);
			const location =
				stripTags(
					piece.match(
						/<p\b[^>]*class="[^"]*\bace-cal-list-event-venue\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
					)?.[1] ?? "",
				) || null;
			const synopsisHtml =
				piece.match(
					/<div\b[^>]*class="[^"]*\bace-cal-list-event-synopsis\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
				)?.[1] ?? null;
			const thumbSrc =
				piece.match(
					/<img\b[^>]*class="[^"]*\bace-cal-list-event-image-img\b[^"]*"[^>]*src=["']([^"']+)["']/i,
				)?.[1] ??
				piece.match(/<img\b[^>]*src=["']([^"']*\/media\/[^"']+)["']/i)?.[1] ??
				null;
			const ticketHref =
				piece.match(/href=["']([^"']*smartseat[^"']*itemNumber=\d+[^"']*)["']/i)?.[1] ?? null;
			const itemNumber = ticketHref?.match(/itemNumber=(\d+)/i)?.[1] ?? null;

			let ymd = day.ymd ?? parseProseDate(timeText);
			if (!ymd) continue;
			const clock = parseClock(timeText) ?? "19:30:00";

			events.push({
				title,
				ymd,
				clock,
				rawDateText: timeText ? `${ymd} ${timeText}` : ymd,
				ticketUrl: ticketHref ? absoluteUrl(ticketHref, origin) : null,
				itemNumber,
				detailUrl: detailHref
					? absoluteUrl(detailHref, origin)
					: absoluteUrl(`/calendar/?date=${ymd}&layout=B`, origin),
				imageUrl: cleanImageUrl(thumbSrc, origin),
				description: synopsisHtml ? stripTags(synopsisHtml) : null,
				location,
			});
		}
	}
	return events;
}

/** Prefer on-page production title over slug hints (e.g. "Sally & Tom"). */
function extractAceProductionTitle(html: string, titleHint?: string | null): string {
	const h1 = stripTags(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
	if (h1 && h1.length > 1 && !/calendar|search|login/i.test(h1)) return h1;

	const og = decodeEntities(
		html.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
			html.match(/content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1] ??
			"",
	);
	// og often "Sally & Tom | ACE Commerce" — keep left side
	const ogClean = og.split("|")[0]?.trim() ?? "";
	if (ogClean && ogClean.length > 1 && !/^zach/i.test(ogClean)) return ogClean;

	// Hero block often: venue · dates · Title · synopsis
	const block = extractAceBlockInnerChunks(html)[0];
	if (block) {
		const titled = block.match(
			/(?:January|February|March|April|May|June|July|August|September|October|November|December)[^\n]{0,40}\d{4}\s+([A-Z][^.]{2,80}?)(?:\s{2,}|\s+(?:When|Who|With|A |The |In ))/i,
		);
		if (titled?.[1]) {
			const t = titled[1].replace(/\s+/g, " ").trim();
			if (t.length >= 2 && t.length <= 80) return t;
		}
	}

	if (titleHint?.trim()) return titleHint.trim();
	return "Untitled";
}

/** Parse performances from a browser-rendered production PDP. */
export function parseAcePdpPerformances(
	html: string,
	pageUrl: string,
	titleHint?: string | null,
): AcePerformance[] {
	const origin = new URL(pageUrl).origin;
	const title = extractAceProductionTitle(html, titleHint);
	const media = parseAceDetailMedia(html, pageUrl);

	// Split by list items that contain smartseat links (performance rows)
	const rowRe = /<li\b[^>]*class="[^"]*\bace-pr[^"]*"[^>]*>/gi;
	const starts: number[] = [];
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(html)) !== null) starts.push(m.index);

	const chunks: string[] = [];
	if (starts.length > 0) {
		for (let i = 0; i < starts.length; i++) {
			const start = starts[i];
			const end = i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, start + 4_000);
			chunks.push(html.slice(start, end));
		}
	} else {
		// Fallback: window around each smartseat link
		const linkRe = /href=["']([^"']*smartseat[^"']*itemNumber=\d+[^"']*)["']/gi;
		let lm: RegExpExecArray | null;
		while ((lm = linkRe.exec(html)) !== null) {
			chunks.push(html.slice(Math.max(0, lm.index - 600), lm.index + 200));
		}
	}

	const events: AcePerformance[] = [];
	const seen = new Set<string>();

	for (const chunk of chunks) {
		const ticketHref =
			chunk.match(/href=["']([^"']*smartseat[^"']*itemNumber=\d+[^"']*)["']/i)?.[1] ?? null;
		if (!ticketHref) continue;
		const itemNumber = ticketHref.match(/itemNumber=(\d+)/i)?.[1] ?? null;

		const subtitleTexts = [
			...chunk.matchAll(/<p\b[^>]*class="[^"]*\bsubtitle-text\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi),
		].map((x) => stripTags(x[1]));

		let ymd: string | null = null;
		let clock: string | null = null;
		let rawParts: string[] = [];
		for (const t of subtitleTexts) {
			const d = parseProseDate(t);
			const c = parseClock(t);
			if (d) {
				ymd = d;
				rawParts.push(t);
			}
			if (c) {
				clock = c;
				rawParts.push(t);
			}
		}
		// Also scan whole chunk text
		if (!ymd) ymd = parseProseDate(stripTags(chunk));
		if (!clock) clock = parseClock(stripTags(chunk));
		if (!ymd || !clock) continue;

		const key = `${itemNumber ?? ""}|${ymd}|${clock}`;
		if (seen.has(key)) continue;
		seen.add(key);

		events.push({
			title,
			ymd,
			clock,
			rawDateText: rawParts.join(" · ") || `${ymd} ${clock}`,
			ticketUrl: absoluteUrl(ticketHref, origin),
			itemNumber,
			detailUrl: pageUrl,
			imageUrl: media.image_url,
			description: media.description,
			location: null,
		});
	}

	return events;
}

/** Boilerplate / policy copy that is not a show synopsis. */
function isNoiseDescription(text: string): boolean {
	return /cookie|privacy|newsletter|sign up|know before you go|all sales are final|senior discount|military|student rush|patrons 65|pay what you wish|ticket reseller|group discounts|accessible seating|subject to availability|zach's senior discount/i.test(
		text,
	);
}

/**
 * Cut trailing production metadata that often trails the real synopsis when we
 * scrape a wide ace-block-inner window (Age Recommendation, Runtime, Pride Night…).
 */
function trimSynopsisMetadata(text: string): string {
	let t = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	// Hard stop at first metadata heading
	const cut = t.search(
		/\b(?:Age Recommendation|Runtime|Pride Night|Champagne Opening|Zachademia|Sign-Interpreted|ABOUT THE PLAYWRIGHT|WRITTEN BY|BOOK,\s*MUSIC|KNOW BEFORE YOU GO|Cast|Plan Your Visit)\b/i,
	);
	if (cut > 60) t = t.slice(0, cut).trim();
	// Drop trailing credits line fragments
	t = t.replace(/\s+(?:WRITTEN BY|MUSIC BY|LYRICS BY|BOOK,)[\s\S]*$/i, "").trim();
	return t;
}

/**
 * Extract text windows starting at each ace-block-inner open tag.
 * Nested divs break simple non-greedy `</div>` matches, so we take a
 * fixed window and strip tags (Sally & Tom hero synopsis lives here).
 */
function extractAceBlockInnerChunks(html: string): string[] {
	const starts = [
		...html.matchAll(/<div\b[^>]*class="[^"]*\bace-block-inner\b[^"]*"[^>]*>/gi),
	];
	return starts.map((m) => {
		const start = m.index ?? 0;
		return stripTags(html.slice(start, start + 4_000));
	});
}

/**
 * Pull the synopsis paragraph out of an ace-block-inner hero blob like:
 * "The Kleberg July 22 - August 23, 2026 Sally & Tom Who gets to write…"
 */
function synopsisFromAceBlock(blockText: string): string | null {
	if (!blockText || blockText.length < 80) return null;
	// Drop leading venue + date range
	let t = blockText
		.replace(
			/^(?:The\s+)?(?:Topfer|Kleberg|Whisenhunt|People'?s Plaza|Studios|Classrooms|Zach North)\b[^.]*?\d{4}\s*/i,
			"",
		)
		.trim();
	// Drop leading title words before narrative openers
	const narrative = t.match(
		/\b((?:When|Who|With|What|Where|A |An |The |In |On |After |Before |Based )[\s\S]{60,})$/i,
	);
	if (narrative?.[1]) t = narrative[1].trim();
	t = t
		.replace(
			/^[A-Z][A-Za-z0-9'&:.!,-]*(?:\s+[A-Z][A-Za-z0-9'&:.!,-]*){0,6}\s+(?=(?:When|Who|With|What|A |An |The |In ))/,
			"",
		)
		.trim();
	t = trimSynopsisMetadata(t);
	if (t.length < 80 || isNoiseDescription(t)) return null;
	return t;
}

interface DescCandidate {
	text: string;
	/** Higher = preferred exact selector match from user path */
	priority: number;
}

/**
 * Production page media + synopsis.
 *
 * Selectors (user-confirmed on zachtheater.org PDPs) — priority order:
 * 1. Annie: div.TypographyPresentation…RichText3-paragraph / HighlightSol
 * 2. Come From Away: p[dir="ltr"] long synopsis paragraph
 * 3. Sally & Tom: div.ace-block-inner.stack-lg hero block (synopsis only)
 *
 * Do NOT pick the longest blob — wide ace-block-inner windows include Age/Runtime
 * and win length-based selection, burying the clean synopsis the user pointed to.
 */
export function parseAceDetailMedia(
	html: string,
	pageUrl: string,
): { image_url: string | null; description: string | null } {
	const origin = new URL(pageUrl).origin;

	const ogImage =
		html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ??
		null;

	const landscape =
		html.match(/src=["']([^"']*\/media\/[^"']*landscape[^"']*)["']/i)?.[1] ??
		html.match(/srcset=["']([^"'?\s]*\/media\/[^"'?\s]*landscape[^"'?\s]*)/i)?.[1] ??
		null;

	const firstMedia =
		html.match(/src=["']([^"']*\/media\/[^"']+\.(?:png|jpe?g|webp)[^"']*)["']/i)?.[1] ?? null;

	const image_url = cleanImageUrl(landscape ?? ogImage ?? firstMedia, origin);

	const candidates: DescCandidate[] = [];
	const push = (raw: string, priority: number) => {
		const t = trimSynopsisMetadata(raw);
		if (t.length > 80 && !isNoiseDescription(t)) candidates.push({ text: t, priority });
	};

	// Priority 100 — Annie TypographyPresentation / RichText3 / HighlightSol
	for (const m of html.matchAll(
		/<div\b[^>]*class="[^"]*TypographyPresentation[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
	)) {
		push(stripTags(m[1]), 100);
	}
	for (const m of html.matchAll(
		/<div\b[^>]*class="[^"]*RichText3-paragraph[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
	)) {
		push(stripTags(m[1]), 100);
	}
	for (const m of html.matchAll(
		/<div\b[^>]*class="[^"]*HighlightSol--buildingBlock[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
	)) {
		push(stripTags(m[1]), 100);
	}
	for (const m of html.matchAll(
		/<div\b[^>]*class="[^"]*HighlightSol[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
	)) {
		push(stripTags(m[1]), 95);
	}

	// Priority 90 — Come From Away p[dir=ltr] synopsis (not discount blurbs)
	for (const m of html.matchAll(/<p\b[^>]*dir=["']ltr["'][^>]*>([\s\S]*?)<\/p>/gi)) {
		const t = stripTags(m[1]);
		if (t.length > 100) push(t, 90);
	}

	// Priority 80 — Sally & Tom ace-block-inner.stack-lg (and generic ace-block-inner)
	for (const m of html.matchAll(
		/<div\b[^>]*class="[^"]*\bace-block-inner\b[^"]*\bstack-lg\b[^"]*"[^>]*>/gi,
	)) {
		const chunk = stripTags(html.slice(m.index ?? 0, (m.index ?? 0) + 4_000));
		const syn = synopsisFromAceBlock(chunk);
		if (syn) push(syn, 80);
	}
	for (const block of extractAceBlockInnerChunks(html)) {
		const syn = synopsisFromAceBlock(block);
		if (syn) push(syn, 70);
	}

	// Generic rich text last
	for (const m of html.matchAll(/<div\b[^>]*class="[^"]*RichText[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
		push(stripTags(m[1]), 40);
	}

	// Highest priority wins; among same priority, prefer longer clean text (capped)
	candidates.sort((a, b) => b.priority - a.priority || b.text.length - a.text.length);
	let description = candidates[0]?.text ?? null;

	if (!description) {
		const metaDesc =
			html.match(/name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
			html.match(/content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ??
			null;
		if (metaDesc && !isNoiseDescription(metaDesc)) {
			description = trimSynopsisMetadata(decodeEntities(metaDesc));
		}
	}

	if (description && description.length > 1200) {
		description = description.slice(0, 1200).replace(/\s+\S*$/, "") + "…";
	}

	return { image_url, description };
}

/** Discover /tickets/pdps/* production URLs from shows + calendar shell. */
export function discoverAceProductionUrls(html: string, baseUrl: string): string[] {
	const origin = siteOrigin(baseUrl);
	const urls = new Set<string>();
	for (const m of html.matchAll(/href=["']([^"']*\/tickets\/pdps\/[a-z0-9-]+\/?)["']/gi)) {
		urls.add(absoluteUrl(m[1], origin).replace(/\/?$/, "/"));
	}
	return [...urls];
}

async function renderSafe(
	browser: CloudflareEnv["BROWSER"] | undefined,
	url: string,
	selector: string,
	timeout = 45000,
): Promise<string> {
	if (!browser) return fetchPageText(url);
	return renderPageContent(browser, url, {
		waitForSelector: { selector, timeout },
		gotoOptions: { waitUntil: "networkidle2", timeout: 60000 },
		bestAttempt: true,
	});
}

function toEvents(
	perfs: AcePerformance[],
	venueName: string,
	address: string | null,
	timezone: string,
	scrapeDaysAhead: number,
): PartnerEvent[] {
	const cutoff = Date.now() + scrapeDaysAhead * 864e5;
	const out: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const ev of perfs) {
		const wall = `${ev.ymd} ${ev.clock}`;
		let startsAt: string;
		try {
			startsAt = localWallTimeToUtcIso(wall, timezone);
		} catch {
			continue;
		}
		const t = new Date(startsAt).getTime();
		if (Number.isNaN(t)) continue;
		if (t < Date.now() - 864e5) continue;
		if (t > cutoff) continue;

		const dedupe = ev.itemNumber
			? `item-${ev.itemNumber}`
			: `${ev.title}|${startsAt}`.toLowerCase();
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);

		out.push(
			toPartnerEvent({
				title: ev.title,
				starts_at: startsAt,
				ends_at: null,
				venue_name: venueName,
				address,
				description: ev.description,
				image_url: ev.imageUrl,
				source_url: ev.detailUrl,
				source_partner: "ace_calendar",
				source_event_id: ev.itemNumber
					? `ace-item-${ev.itemNumber}`
					: `ace-${ev.ymd}-${ev.clock}-${ev.title}`.toLowerCase().replace(/\s+/g, "-").slice(0, 120),
				raw_date_text: ev.rawDateText,
				price_text: null,
				ticket_url: ev.ticketUrl,
				confidence: ev.ticketUrl ? 0.95 : 0.85,
			}),
		);
	}

	out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return out;
}

export async function fetchAceCalendarEvents(params: {
	calendarHtml?: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	browser?: CloudflareEnv["BROWSER"];
	maxProductions?: number;
}): Promise<PartnerEvent[]> {
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 90;
	const maxProductions = params.maxProductions ?? 12;
	const origin = siteOrigin(params.calendarUrl);
	const allPerfs: AcePerformance[] = [];

	// 1) LIST calendar attempt (layout=B) — often empty under bot protection
	if (params.calendarHtml && /ace-cal-list-event/i.test(params.calendarHtml)) {
		allPerfs.push(...parseAceListHtml(params.calendarHtml, params.calendarUrl));
	}
	if (allPerfs.length === 0 && params.browser) {
		const listUrl = `${origin}/calendar/?date=${new Date().toISOString().slice(0, 10)}&layout=B`;
		try {
			const listHtml = await renderSafe(
				params.browser,
				listUrl,
				".ace-cal-list-event, .ace-cal-list-event-content, .ace-cal-list-day",
				30000,
			);
			allPerfs.push(...parseAceListHtml(listHtml, listUrl));
		} catch {
			/* fall through to PDP path */
		}
	}

	// 2) Production PDP path (reliable for ZACH)
	const seedHtml =
		params.calendarHtml && params.calendarHtml.length > 2000
			? params.calendarHtml
			: await fetchPageText(`${origin}/tickets/shows/`).catch(() => "");
	let productionUrls = discoverAceProductionUrls(seedHtml, origin);

	// Also harvest from calendar shell + homepage footer "On Stage"
	for (const seed of [`${origin}/calendar/`, `${origin}/`]) {
		try {
			const h = await fetchPageText(seed);
			productionUrls.push(...discoverAceProductionUrls(h, origin));
		} catch {
			/* ignore */
		}
	}
	productionUrls = [...new Set(productionUrls)].slice(0, maxProductions);

	for (const pdpUrl of productionUrls) {
		try {
			const html = await renderSafe(
				params.browser,
				pdpUrl,
				'a[href*="smartseat"], .ace-production-row-date-avail, .subtitle-text',
				40000,
			);
			// If still no smartseat (bot challenge), skip
			if (!/smartseat/i.test(html)) continue;
			const slugTitle = pdpUrl
				.split("/pdps/")[1]
				?.replace(/\/$/, "")
				?.replace(/-/g, " ")
				?.replace(/\b\w/g, (c) => c.toUpperCase());
			allPerfs.push(...parseAcePdpPerformances(html, pdpUrl, slugTitle));
		} catch {
			/* next production */
		}
	}

	return toEvents(allPerfs, params.venueName, params.address, params.timezone, scrapeDaysAhead);
}
