/**
 * SpotApps / SpotHopper venue events.
 *
 * Layout A — listing sections (Moontower Saloon et al.):
 *   div.events-holder
 *     section#EVENT_ID
 *       img.event-image                     → flyer (//static.spotapps.co/…)
 *       h2                                  → title
 *       h3 (not .event-time)                → date label e.g. "Saturday July 18th"
 *       div.event-info-text                 → description
 *       h3.event-time                       → "08:00 PM - 11:00 PM"
 *       var.atc_date_start / atc_date_end   → authoritative local wall times
 *
 * Layout B — pinboard / agenda (Doc's Bar and Grill / eatdrinkdocs.com):
 *   #eventPinboardViewItem (Agenda tab)
 *   #pinboardAgendaContainer.events-pinboard-view  (with #monthFilter = all)
 *     div.event-calendar-card
 *       data-event-start-date / data-event-end-date / data-event-start-time / id
 *       img.img-responsive                  → flyer
 *       div.event-text-holder
 *         h2, p.event-day, div.event-info-text
 *
 * Events are free; no per-event ticket URL — source_url is the calendar page.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

export function isSpotAppsCalendar(html: string, pageUrl: string): boolean {
	const hay = `${pageUrl}\n${html}`;
	if (/moontowersaloon\.com/i.test(pageUrl)) return true;
	if (/eatdrinkdocs\.com/i.test(pageUrl)) return true;
	// Pinboard / agenda calendar cards (Doc's Backyard et al.)
	if (
		/event-calendar-card/i.test(html) &&
		(/pinboardAgendaContainer|events-pinboard-view|data-event-start-date/i.test(html) ||
			/static\.spotapps\.co/i.test(hay))
	) {
		return true;
	}
	if (/static\.spotapps\.co/i.test(hay) && /event-image|events-holder/i.test(html)) return true;
	if (/events-holder/i.test(html) && /event-time/i.test(html) && /atc_date_start/i.test(html)) {
		return true;
	}
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
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\s+/g, " ")
		.trim();
}

function absImg(src: string | null | undefined, pageUrl: string): string | null {
	if (!src) return null;
	if (src.startsWith("//")) return `https:${src}`;
	if (src.startsWith("/")) {
		try {
			return new URL(src, pageUrl).toString();
		} catch {
			return src;
		}
	}
	return src;
}

function parseClock12(text: string): string | null {
	const m = text.replace(/\u202f/g, " ").match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
	if (!m) return null;
	let h = Number(m[1]);
	const min = Number(m[2]);
	const ap = m[3].toUpperCase();
	if (ap === "PM" && h < 12) h += 12;
	if (ap === "AM" && h === 12) h = 0;
	return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
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

/** "Saturday July 18th" → ymd using year (rollover if month already passed far). */
function parseDateHeading(text: string, now = new Date()): string | null {
	const m = text.match(
		/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i,
	);
	if (!m) return null;
	const month = MONTHS[m[1].toLowerCase()];
	const day = Number(m[2]);
	let year = m[3] ? Number(m[3]) : now.getFullYear();
	if (!month || !day) return null;
	if (!m[3]) {
		const candidate = new Date(year, month - 1, day, 23, 59, 59);
		// If date is >30 days in the past, assume next year
		if (candidate.getTime() < now.getTime() - 30 * 864e5) year += 1;
	}
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractSections(html: string): { id: string; body: string }[] {
	const out: { id: string; body: string }[] = [];
	const re = /<section\b[^>]*\bid=["'](\d+)["'][^>]*>([\s\S]*?)<\/section>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		out.push({ id: m[1], body: m[2] });
	}
	// Fallback: events-holder chunks without section ids
	if (out.length === 0) {
		const holders = [...html.matchAll(/class=["'][^"']*\bevents-holder\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bevents-holder\b|<\/div>\s*<footer|$)/gi)];
		for (const h of holders) {
			const chunk = h[1];
			if (!/event-image|event-time|atc_date_start/i.test(chunk)) continue;
			out.push({ id: `hash-${out.length}`, body: chunk });
		}
	}
	return out;
}

function isJunkTitle(title: string, opts?: { allowNationalDays?: boolean }): boolean {
	if (!title || title.length < 2) return true;
	// AI-scrape style date-as-title
	if (
		/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/i.test(
			title,
		)
	) {
		return true;
	}
	if (/^\w+day,?\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?\s+at\s+\d/i.test(title)) return true;
	if (/we'?re open|hours of operation|open at \d/i.test(title)) return true;
	if (/^Events$/i.test(title)) return true;
	// Pure holiday promos without a band name (Moontower listing layout only —
	// pinboard venues like Doc's intentionally list National * Day specials)
	if (
		!opts?.allowNationalDays &&
		(/^National\s+.+\s+Day$/i.test(title) || /^(Labor Day|Memorial Day)$/i.test(title))
	) {
		return true;
	}
	return false;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#039;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");
}

/**
 * Pinboard / agenda cards: div.event-calendar-card with data-event-* attrs
 * (Doc's Backyard / eatdrinkdocs.com/events Agenda + All months).
 */
function extractPinboardCards(html: string): string[] {
	const starts: number[] = [];
	const re = /<div\b[^>]*\bevent-calendar-card\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) starts.push(m.index);
	if (starts.length === 0) return [];

	const cards: string[] = [];
	for (let i = 0; i < starts.length; i++) {
		const start = starts[i]!;
		const end = starts[i + 1] ?? Math.min(html.length, start + 6000);
		cards.push(html.slice(start, end));
	}
	return cards;
}

function parseClock24or12(text: string): string | null {
	const t = text.replace(/\u202f/g, " ").trim();
	// "10:00" or "10:00:00" (24h) from data-event-start-time
	const m24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (m24) {
		const h = Number(m24[1]);
		const min = Number(m24[2]);
		const sec = m24[3] ? Number(m24[3]) : 0;
		if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
			return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
		}
	}
	return parseClock12(t);
}

function ymdFromIsoDateAttr(value: string | null | undefined): string | null {
	if (!value) return null;
	const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
	return m?.[1] ?? null;
}

export function parseSpotAppsPinboardEvents(params: {
	html: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
}): PartnerEvent[] {
	const {
		html,
		calendarUrl,
		venueName,
		address = null,
		timezone = "America/Chicago",
		scrapeDaysAhead = 180,
	} = params;

	const now = Date.now();
	const pastFloor = now - 12 * 60 * 60 * 1000;
	const cutoff = now + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	// Prefer agenda container if present (avoids duplicate calendar-view cards)
	const scopeMatch = html.match(
		/id=["']pinboardAgendaContainer["'][^>]*>([\s\S]*?)(?=<div\b[^>]*id=["'](?:pinboard|calendar|noEvents)|$)/i,
	);
	const scope = scopeMatch?.[1] ?? html;

	for (const body of extractPinboardCards(scope)) {
		const id =
			body.match(/\bid=["'](\d+)["']/i)?.[1] ??
			body.match(/data-event-id=["'](\d+)["']/i)?.[1] ??
			"";
		const startDateAttr =
			body.match(/data-event-start-date=["']([^"']+)["']/i)?.[1] ?? null;
		const endDateAttr = body.match(/data-event-end-date=["']([^"']+)["']/i)?.[1] ?? null;
		const startTimeAttr =
			body.match(/data-event-start-time=["']([^"']+)["']/i)?.[1] ?? null;
		const endTimeAttr = body.match(/data-event-end-time=["']([^"']+)["']/i)?.[1] ?? null;
		const recurrence =
			body.match(/data-event-recurrence-type=["']([^"']+)["']/i)?.[1] ?? null;

		const titleRaw =
			stripTags(body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "") ||
			stripTags(
				(body.match(/aria-label=["']([^"']+)["']/i)?.[1] ?? "")
					.split(".")[0]
					?.trim() ?? "",
			);
		const title = decodeEntities(titleRaw);
		if (isJunkTitle(title, { allowNationalDays: true })) continue;

		const ymd = ymdFromIsoDateAttr(startDateAttr);
		const startClock = startTimeAttr ? parseClock24or12(startTimeAttr) : "20:00:00";
		if (!ymd || !startClock) continue;

		const endYmd = ymdFromIsoDateAttr(endDateAttr) || ymd;
		const endClock = endTimeAttr ? parseClock24or12(endTimeAttr) : null;

		const startLocal = `${ymd} ${startClock}`;
		let endLocal: string | null = endClock ? `${endYmd} ${endClock}` : null;

		let startsAt: string;
		let endsAt: string | null = null;
		try {
			startsAt = localWallTimeToUtcIso(startLocal, timezone);
			if (endLocal) {
				endsAt = localWallTimeToUtcIso(endLocal, timezone);
				if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
					// Same-day end before start → push end +1 day
					const [ey, ec] = endLocal.split(" ");
					const d = new Date(`${ey}T12:00:00Z`);
					d.setUTCDate(d.getUTCDate() + 1);
					endsAt = localWallTimeToUtcIso(`${d.toISOString().slice(0, 10)} ${ec}`, timezone);
				}
			}
		} catch {
			continue;
		}

		const startMs = new Date(startsAt).getTime();
		if (Number.isNaN(startMs)) continue;
		if (startMs < pastFloor) continue;
		if (startMs > cutoff) continue;

		const imageUrl = absImg(
			body.match(
				/<img\b[^>]*class=["'][^"']*\bimg-responsive\b[^"']*["'][^>]*src=["']([^"']+)["']/i,
			)?.[1] ??
				body.match(
					/src=["']([^"']+)["'][^>]*class=["'][^"']*\bimg-responsive\b[^"']*["']/i,
				)?.[1] ??
				body.match(/src=["']((?:https?:)?\/\/static\.spotapps\.co\/[^"']+)["']/i)?.[1] ??
				null,
			calendarUrl,
		);

		const dayLabel = stripTags(
			body.match(/class=["'][^"']*\bevent-day\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "",
		);
		// Visible description paragraphs inside event-info-text (skip display:none meta)
		const infoBlock =
			body.match(
				/<div\b[^>]*class=["'][^"']*\bevent-info-text\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["']event-text-holder|<\/div>\s*<\/div>\s*$)/i,
			)?.[1] ??
			body.match(/class=["'][^"']*\bevent-info-text\b[^"']*["'][^>]*>([\s\S]{0,2000})/i)?.[1] ??
			"";
		const infoClean = infoBlock
			.replace(/<div\b[^>]*(?:style=["'][^"']*display:\s*none)[^>]*>[\s\S]*?<\/div>/gi, " ")
			.replace(/<div\b[^>]*data-event-id[^>]*>[\s\S]*?<\/div>/gi, " ");
		const infoText = stripTags(infoClean);
		const description =
			(infoText && infoText.length >= 3 ? decodeEntities(infoText) : null) ||
			(dayLabel ? decodeEntities(dayLabel) : null);

		const sourceEventId = id
			? `spotapps:${id}`
			: `spotapps:${title.toLowerCase()}|${startLocal}`;
		const dedupe = `${title.toLowerCase()}|${startsAt}`;
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);

		const rawDateText =
			[dayLabel, startTimeAttr, recurrence && recurrence !== "Does not Repeat" ? recurrence : ""]
				.filter(Boolean)
				.join(" · ") || startLocal;

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: endsAt,
				venue_name: venueName,
				address,
				description,
				image_url: imageUrl,
				source_url: calendarUrl,
				source_partner: "spotapps",
				source_event_id: sourceEventId,
				raw_date_text: rawDateText,
				price_text: null,
				ticket_url: null,
				confidence: 0.94,
			}),
		);
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

export function parseSpotAppsEvents(params: {
	html: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
}): PartnerEvent[] {
	const {
		html,
		calendarUrl,
		venueName,
		address = null,
		timezone = "America/Chicago",
		scrapeDaysAhead = 120,
	} = params;

	// Prefer pinboard/agenda cards when present (Doc's et al.)
	if (/event-calendar-card/i.test(html)) {
		const pinboard = parseSpotAppsPinboardEvents({
			html,
			calendarUrl,
			venueName,
			address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 180),
		});
		if (pinboard.length > 0) return pinboard;
	}

	const now = Date.now();
	const pastFloor = now - 12 * 60 * 60 * 1000;
	const cutoff = now + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const { id, body } of extractSections(html)) {
		const title =
			stripTags(body.match(/<var\b[^>]*class=["']atc_title["'][^>]*>([\s\S]*?)<\/var>/i)?.[1] ?? "") ||
			stripTags(body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "") ||
			stripTags(
				(body.match(/class=["'][^"']*\bevent-image\b[^"']*["'][^>]*alt=["']([^"']*)/i)?.[1] ?? "").replace(
					/\s*event photo\s*$/i,
					"",
				),
			);

		if (isJunkTitle(title)) continue;

		// Prefer add-to-calendar machine times (local wall clock)
		const atcStart = body.match(
			/<var\b[^>]*class=["']atc_date_start["'][^>]*>(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})<\/var>/i,
		);
		const atcEnd = body.match(
			/<var\b[^>]*class=["']atc_date_end["'][^>]*>(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})<\/var>/i,
		);
		const atcTz =
			stripTags(body.match(/<var\b[^>]*class=["']atc_timezone["'][^>]*>([\s\S]*?)<\/var>/i)?.[1] ?? "") ||
			timezone;

		// Visible date heading (not event-time)
		const dateHeading =
			stripTags(
				body.match(/<h3\b(?![^>]*event-time)[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "",
			) || "";
		const timeHeading = stripTags(
			body.match(/<h3\b[^>]*class=["'][^"']*\bevent-time\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ??
				"",
		);

		let startLocal: string | null = null;
		let endLocal: string | null = null;

		if (atcStart) {
			startLocal = `${atcStart[1]} ${atcStart[2]}`;
			if (atcEnd) endLocal = `${atcEnd[1]} ${atcEnd[2]}`;
		} else {
			const ymd = parseDateHeading(dateHeading);
			const clocks = [...timeHeading.matchAll(/\b\d{1,2}:\d{2}\s*[AP]M\b/gi)].map((x) => x[0]);
			const startClock = clocks[0] ? parseClock12(clocks[0]) : "20:00:00";
			const endClock = clocks[1] ? parseClock12(clocks[1]) : null;
			if (!ymd || !startClock) continue;
			startLocal = `${ymd} ${startClock}`;
			if (endClock) endLocal = `${ymd} ${endClock}`;
		}

		if (!startLocal) continue;

		let startsAt: string;
		let endsAt: string | null = null;
		try {
			startsAt = localWallTimeToUtcIso(startLocal, atcTz);
			if (endLocal) {
				endsAt = localWallTimeToUtcIso(endLocal, atcTz);
				// Overnight / inverted end (e.g. 8pm–11am same calendar day in ATC)
				if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
					const [ymd, clock] = endLocal.split(" ");
					const d = new Date(`${ymd}T12:00:00Z`);
					d.setUTCDate(d.getUTCDate() + 1);
					const nextYmd = d.toISOString().slice(0, 10);
					endsAt = localWallTimeToUtcIso(`${nextYmd} ${clock}`, atcTz);
				}
			}
		} catch {
			continue;
		}

		const startMs = new Date(startsAt).getTime();
		if (Number.isNaN(startMs)) continue;
		if (startMs < pastFloor) continue;
		if (startMs > cutoff) continue;

		const imageUrl = absImg(
			body.match(
				/<img\b[^>]*class=["'][^"']*\bevent-image\b[^"']*["'][^>]*src=["']([^"']+)["']/i,
			)?.[1] ??
				body.match(
					/src=["']([^"']+)["'][^>]*class=["'][^"']*\bevent-image\b[^"']*["']/i,
				)?.[1] ??
				body.match(/src=["']((?:https?:)?\/\/static\.spotapps\.co\/[^"']+)["']/i)?.[1] ??
				null,
			calendarUrl,
		);

		// Description: atc_description or event-info-text (up to event-time heading)
		const atcDesc = stripTags(
			body.match(/<var\b[^>]*class=["']atc_description["'][^>]*>([\s\S]*?)<\/var>/i)?.[1] ?? "",
		);
		const infoHtml =
			body.match(
				/class=["'][^"']*\bevent-info-text\b[^"']*["'][^>]*>([\s\S]*?)(?=<h3\b[^>]*class=["'][^"']*\bevent-time|class=["']event-add-to-calendar)/i,
			)?.[1] ?? "";
		const infoClean = infoHtml.replace(
			/<div\b[^>]*(?:data-event-id|style=["']display:\s*none)[^>]*>[\s\S]*?<\/div>/gi,
			" ",
		);
		const infoText = stripTags(infoClean);
		const description =
			(atcDesc && atcDesc.length >= 3 ? atcDesc : null) ||
			(infoText && infoText.length >= 3 ? infoText : null);

		const sourceEventId = /^\d+$/.test(id) ? `spotapps:${id}` : `spotapps:${title.toLowerCase()}|${startLocal}`;
		const dedupe = `${title.toLowerCase()}|${startsAt}`;
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);

		const rawDateText =
			[dateHeading, timeHeading].filter(Boolean).join(" · ") || startLocal;

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: endsAt,
				venue_name: venueName,
				address,
				description,
				image_url: imageUrl,
				// Free shows — no per-event URL; listing page is the source
				source_url: calendarUrl,
				source_partner: "spotapps",
				source_event_id: sourceEventId,
				raw_date_text: rawDateText,
				price_text: "Free",
				ticket_url: null,
				confidence: 0.93,
			}),
		);
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

export async function fetchSpotAppsEvents(params: {
	calendarHtml?: string;
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
}): Promise<PartnerEvent[]> {
	const html = params.calendarHtml ?? (await fetchPageText(params.calendarUrl));
	return parseSpotAppsEvents({
		html,
		calendarUrl: params.calendarUrl,
		venueName: params.venueName,
		address: params.address,
		timezone: params.timezone,
		scrapeDaysAhead: params.scrapeDaysAhead,
	});
}
