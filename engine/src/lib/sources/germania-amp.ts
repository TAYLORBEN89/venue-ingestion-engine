/**
 * Germania Insurance Amphitheater (germaniaamp.com) — HTML card listing + detail enrich.
 *
 * List:  http://germaniaamp.com/events/
 *   div.columns.upcoming-shows → div.card.events
 *   image: card-image img
 *   title: h2.title
 *   date:  .media-left span + month text + em year
 *
 * Detail: /events/{slug}
 *   date/time: h2.subtitle  "July 26, 2026  //  06:30 pm"
 *   ticket:    ticketmaster.com/event/...
 *   artists:   .card.artist after "About the Artist" (first = headliner)
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

export type GermaniaListingCard = {
	slug: string;
	title: string;
	/** YYYY-MM-DD from list card */
	dateYmd: string;
	imageUrl: string | null;
	detailUrl: string;
	rawDateText: string;
};

export type GermaniaArtist = {
	name: string;
	imageUrl: string | null;
	websiteUrl: string | null;
};

export function isGermaniaAmpCalendar(html: string, pageUrl: string): boolean {
	if (/germaniaamp\.com/i.test(pageUrl)) return true;
	return (
		/upcoming-shows/i.test(html) &&
		/card events/i.test(html) &&
		/media-left/i.test(html) &&
		/Buy Tickets/i.test(html)
	);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/gi, "&")
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

function absUrl(href: string, base: string): string {
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Parse list-card date: <span>26</span>Jul<br><em>2026</em> */
export function parseListCardDate(chunk: string): { ymd: string; raw: string } | null {
	const m = chunk.match(
		/<div[^>]*class="[^"]*media-left[^"]*"[^>]*>\s*<span>\s*(\d{1,2})\s*<\/span>\s*([A-Za-z]{3,9})\s*(?:<br\s*\/?>)?\s*<em>\s*(\d{4})\s*<\/em>/i,
	);
	if (!m) return null;
	const day = Number(m[1]);
	const mon = MONTHS[m[2].toLowerCase()];
	const year = Number(m[3]);
	if (!mon || !day || !year) return null;
	const ymd = `${year}-${pad2(mon)}-${pad2(day)}`;
	return { ymd, raw: `${m[1]} ${m[2]} ${m[3]}` };
}

/** Parse detail subtitle: July 26, 2026 // 06:30 pm */
export function parseDetailDateTime(html: string): {
	ymd: string;
	clock: string;
	raw: string;
} | null {
	const sub = html.match(
		/<h2[^>]*class="[^"]*subtitle(?![^"]*alt)[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h2>/i,
	)?.[1];
	const text = stripTags(sub ?? "");
	const m = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\s*(?:\/\/|·|-)?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i,
	);
	if (!m) {
		// date only
		const dOnly = text.match(
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
		);
		if (!dOnly) return null;
		const mon = MONTHS[dOnly[1].toLowerCase()];
		if (!mon) return null;
		const ymd = `${dOnly[3]}-${pad2(mon)}-${pad2(Number(dOnly[2]))}`;
		return { ymd, clock: "19:00:00", raw: text };
	}
	const mon = MONTHS[m[1].toLowerCase()];
	if (!mon) return null;
	let hour = Number(m[4]);
	const min = Number(m[5]);
	const ap = (m[6] || "").toLowerCase();
	if (ap === "pm" && hour < 12) hour += 12;
	if (ap === "am" && hour === 12) hour = 0;
	// 24h without am/pm (e.g. 18:30)
	if (!ap && hour <= 23) {
		/* keep */
	}
	const ymd = `${m[3]}-${pad2(mon)}-${pad2(Number(m[2]))}`;
	const clock = `${pad2(hour)}:${pad2(min)}:00`;
	return { ymd, clock, raw: text };
}

export function parseGermaniaListingCards(
	html: string,
	listUrl: string,
): GermaniaListingCard[] {
	const out: GermaniaListingCard[] = [];
	const seen = new Set<string>();

	// Prefer the upcoming-shows region when present
	const section =
		html.match(
			/<div[^>]*class="[^"]*upcoming-shows[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*columns[^"]*past|<footer|Our Sponsors|$)/i,
		)?.[1] ?? html;

	const re =
		/<div[^>]*class="[^"]*card events[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*(?:<\/div>|<style|$)/gi;
	let match: RegExpExecArray | null;
	const blocks: string[] = [];
	// Simpler split on card events open tags
	const parts = section.split(/(?=<div[^>]*class="[^"]*card events[^"]*")/i);
	for (const part of parts) {
		if (!/card events/i.test(part)) continue;
		blocks.push(part.slice(0, 2200));
	}

	for (const chunk of blocks) {
		const href =
			chunk.match(/href=["'](https?:\/\/[^"']*\/events\/[^"'#?]+)["']/i)?.[1] ??
			chunk.match(/href=["'](\/events\/[^"'#?]+)["']/i)?.[1];
		if (!href) continue;
		const detailUrl = absUrl(href, listUrl);
		const slug = detailUrl.replace(/\/$/, "").split("/").pop() || "";
		if (!slug || slug === "events" || seen.has(slug)) continue;

		const title = stripTags(chunk.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "");
		if (!title) continue;

		const date = parseListCardDate(chunk);
		if (!date) continue;

		const imageUrl =
			chunk.match(/<div[^>]*class="[^"]*card-image[^"]*"[^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i)?.[1] ??
			chunk.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i)?.[1] ??
			null;

		seen.add(slug);
		out.push({
			slug,
			title,
			dateYmd: date.ymd,
			imageUrl,
			detailUrl,
			rawDateText: date.raw,
		});
	}

	// Fallback: link-based if card class markup changes slightly
	if (out.length === 0) {
		for (const m of section.matchAll(/href=["']((?:https?:\/\/[^"']*)?\/events\/([a-z0-9-]+))["']/gi)) {
			const detailUrl = absUrl(m[1], listUrl);
			const slug = m[2];
			if (seen.has(slug) || slug === "events") continue;
			const start = m.index ?? 0;
			const chunk = section.slice(start, start + 1800);
			const title = stripTags(chunk.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "");
			const date = parseListCardDate(chunk);
			if (!title || !date) continue;
			const imageUrl = chunk.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i)?.[1] ?? null;
			seen.add(slug);
			out.push({ slug, title, dateYmd: date.ymd, imageUrl, detailUrl, rawDateText: date.raw });
		}
	}

	void re;
	return out;
}

export function parseGermaniaArtists(detailHtml: string): GermaniaArtist[] {
	const aboutIdx = detailHtml.search(/About the Artist/i);
	if (aboutIdx < 0) return [];
	// Stop before Upcoming Events footer cards
	const slice = detailHtml.slice(aboutIdx, aboutIdx + 12000);
	const end = slice.search(/<h2[^>]*class="[^"]*subtitle alt[^"]*"[^>]*>\s*Upcoming Events/i);
	const region = end > 0 ? slice.slice(0, end) : slice;

	const artists: GermaniaArtist[] = [];
	const cards = region.split(/(?=<div[^>]*class="[^"]*card artist[^"]*")/i);
	for (const card of cards) {
		if (!/card artist/i.test(card)) continue;
		const name = stripTags(card.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "");
		if (!name || /^visit artist/i.test(name)) continue;
		const imageUrl =
			card.match(/src=["'](https?:\/\/[^"']*artist-images[^"']*)["']/i)?.[1] ??
			card.match(/src=["'](https?:\/\/[^"']+)["']/i)?.[1] ??
			null;
		const websiteUrl =
			card.match(
				/href=["'](https?:\/\/(?!germaniaamp\.com)[^"']+)["'][^>]*>\s*Visit Artist/i,
			)?.[1] ?? null;
		artists.push({ name, imageUrl, websiteUrl });
	}
	return artists;
}

export function parseGermaniaTicketUrl(detailHtml: string): string | null {
	const tm = detailHtml.match(
		/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/event\/[^"'#?]+)/i,
	)?.[1];
	if (tm) return tm.replace(/&amp;/g, "&");
	const anyTm = detailHtml.match(
		/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/[^"']+)["']/i,
	)?.[1];
	return anyTm ? anyTm.replace(/&amp;/g, "&") : null;
}

export function parseGermaniaDescription(detailHtml: string, artists: GermaniaArtist[]): string | null {
	// Prefer first paragraph blocks before About the Artist
	const before = detailHtml.split(/About the Artist/i)[0] ?? detailHtml;
	const paras = [...before.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((m) => stripTags(m[1]))
		.filter((t) => t.length > 40 && !/cookie|privacy|subscribe/i.test(t));
	const parts: string[] = [];
	if (paras[0]) parts.push(paras[0]);
	if (artists.length > 1) {
		parts.push(`With ${artists.slice(1).map((a) => a.name).join(", ")}.`);
	}
	return parts.length ? parts.join("\n\n") : null;
}

async function enrichFromDetail(
	card: GermaniaListingCard,
	timezone: string,
	venueName: string,
	address: string | null,
): Promise<PartnerEvent | null> {
	let detailHtml = "";
	try {
		detailHtml = await fetchPageText(card.detailUrl);
	} catch {
		detailHtml = "";
	}

	const dt = detailHtml ? parseDetailDateTime(detailHtml) : null;
	const ymd = dt?.ymd ?? card.dateYmd;
	const clock = dt?.clock ?? "19:00:00";
	const rawDate = dt?.raw ?? card.rawDateText;

	let startsAt: string;
	try {
		startsAt = localWallTimeToUtcIso(`${ymd} ${clock}`, timezone);
	} catch {
		return null;
	}

	const artists = detailHtml ? parseGermaniaArtists(detailHtml) : [];
	const ticketUrl = detailHtml ? parseGermaniaTicketUrl(detailHtml) : null;
	const description = detailHtml ? parseGermaniaDescription(detailHtml, artists) : null;
	const headlinerImage = artists[0]?.imageUrl ?? null;
	const imageUrl = card.imageUrl ?? headlinerImage;

	// Title: listing title; if multi-artist, keep headliner as title (venue listing style)
	const title = card.title;

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		venue_name: venueName,
		address,
		description,
		image_url: imageUrl,
		source_url: card.detailUrl,
		source_partner: "germania_amp",
		source_event_id: card.slug,
		raw_date_text: rawDate,
		ticket_url: ticketUrl,
		confidence: 1,
	});
}

export async function fetchGermaniaAmpEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	/** When true, fetch each detail page for time/tickets/artists (default true). */
	enrichDetails?: boolean;
	maxEvents?: number;
}): Promise<PartnerEvent[]> {
	const listUrl = params.calendarUrl.includes("/events")
		? params.calendarUrl
		: new URL("/events/", params.calendarUrl).toString();

	// Always fetch the /events/ listing if we were pointed at the homepage
	let html = params.calendarHtml;
	if (!isGermaniaAmpCalendar(html, listUrl) || !/upcoming-shows|card events/i.test(html)) {
		html = await fetchPageText(listUrl);
	}

	const cards = parseGermaniaListingCards(html, listUrl);
	const now = Date.now() - 60 * 60 * 1000;
	const horizon =
		Date.now() + (params.scrapeDaysAhead ?? 180) * 24 * 60 * 60 * 1000;
	const max = params.maxEvents ?? 40;
	const enrich = params.enrichDetails !== false;

	const events: PartnerEvent[] = [];
	for (const card of cards.slice(0, max)) {
		if (enrich) {
			const ev = await enrichFromDetail(
				card,
				params.timezone,
				params.venueName,
				params.address,
			);
			if (!ev) continue;
			const t = new Date(ev.starts_at).getTime();
			if (t < now || t > horizon) continue;
			events.push(ev);
		} else {
			let startsAt: string;
			try {
				startsAt = localWallTimeToUtcIso(`${card.dateYmd} 19:00:00`, params.timezone);
			} catch {
				continue;
			}
			const t = new Date(startsAt).getTime();
			if (t < now || t > horizon) continue;
			events.push(
				toPartnerEvent({
					title: card.title,
					starts_at: startsAt,
					venue_name: params.venueName,
					address: params.address,
					image_url: card.imageUrl,
					source_url: card.detailUrl,
					source_partner: "germania_amp",
					source_event_id: card.slug,
					raw_date_text: card.rawDateText,
					confidence: 0.9,
				}),
			);
		}
	}

	return events;
}
