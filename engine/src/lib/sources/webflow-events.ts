import {
	extractBestEventImage,
	extractTicketUrlFromHtml,
	extractWebflowEventHeroImage,
	extractYouTubeFromHtml,
} from "../event-media";
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { resolveTicketmasterImageFromUrl } from "../ticketmaster-images";
import { renderPageContent } from "../browser";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

const MONTHS: Record<string, number> = {
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
	jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface WebflowListingCard {
	slug: string;
	title: string;
	datePart: string;
	clock: string;
	ticketUrl: string | null;
	imageUrl: string | null;
}

export interface WebflowEventMedia {
	image_url: string | null;
	youtube_embed: string | null;
	youtube_id: string | null;
	ticket_url: string | null;
}

export function isWebflowEventsPage(html: string, pageUrl: string): boolean {
	return /website-files\.com|webflow/i.test(html) && /href=["']\/events\//i.test(html);
}

export function extractWebflowEventSlugs(html: string): string[] {
	return [...new Set([...html.matchAll(/href=["']\/events\/([^"'#?]+)["']/gi)].map((m) => m[1]))];
}

export function extractWebflowPaginationId(html: string): string | null {
	const match = html.match(/\?([a-f0-9]{6,})_page=\d+/i);
	return match?.[1] ?? null;
}

export async function fetchWebflowListingHtml(calendarUrl: string, firstPageHtml?: string): Promise<string> {
	const pages: string[] = [firstPageHtml ?? (await fetchPageText(calendarUrl))];
	const pageId = extractWebflowPaginationId(pages[0]);
	if (!pageId) return pages[0];

	const seenSlugs = new Set(extractWebflowEventSlugs(pages[0]));
	const base = calendarUrl.split("?")[0];

	for (let page = 2; page <= 3; page++) {
		const pageUrl = `${base}?${pageId}_page=${page}`;
		const html = await fetchPageText(pageUrl);
		const slugs = extractWebflowEventSlugs(html);
		const newSlugs = slugs.filter((slug) => !seenSlugs.has(slug));
		if (newSlugs.length === 0) break;
		for (const slug of newSlugs) seenSlugs.add(slug);
		pages.push(html);
	}

	return pages.join("\n");
}

function parseDisplayDate(text: string): string | null {
	const full = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
	);
	if (full) {
		const month = MONTHS[full[1].toLowerCase()];
		const day = Number(full[2]);
		const year = Number(full[3]);
		return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	}

	const abbr = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i);
	if (!abbr) return null;
	const month = MONTHS[abbr[1].toLowerCase()];
	const day = Number(abbr[2]);
	const year = Number(abbr[3]);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseClock(text: string): string | null {
	const match = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!match) return null;
	let hour = Number(match[1]) % 12;
	if (match[3].toLowerCase() === "pm") hour += 12;
	return `${hour}:${match[2]}:00`;
}

function extractListingTicketUrl(chunk: string): string | null {
	return (
		chunk.match(/href=["'](https:\/\/www\.ticketmaster\.com\/event\/[^"']+)["']/i)?.[1] ??
		chunk.match(/href=["'](https:\/\/www\.prekindle\.com\/event\/[^"']+)["']/i)?.[1] ??
		null
	);
}

export function parseWebflowEventMedia(html: string): WebflowEventMedia {
	const youtube = extractYouTubeFromHtml(html);
	return {
		image_url: extractWebflowEventHeroImage(html) ?? extractBestEventImage(html),
		youtube_embed: youtube.youtube_embed,
		youtube_id: youtube.youtube_id,
		ticket_url: extractTicketUrlFromHtml(html),
	};
}

async function fetchEventDetailHtml(
	pageUrl: string,
	browser?: CloudflareEnv["BROWSER"],
	options?: { useBrowser?: boolean },
): Promise<string> {
	const staticHtml = await fetchPageText(pageUrl);
	const needsBrowser =
		options?.useBrowser && browser && /ticketm\.net/i.test(staticHtml) === false && !/website-files\.com/i.test(staticHtml);
	if (!needsBrowser) return staticHtml;

	try {
		const rendered = await renderPageContent(browser, pageUrl);
		return rendered.length > staticHtml.length ? rendered : staticHtml;
	} catch {
		return staticHtml;
	}
}

export async function enrichWebflowEventMedia(
	event: PartnerEvent,
	baseUrl: string,
	options?: {
		browser?: CloudflareEnv["BROWSER"];
		ticketmasterApiKey?: string | null;
	},
): Promise<PartnerEvent> {
	const slug = event.source_event_id;
	if (!slug) return event;

	const pageUrl = new URL(`/events/${slug}`, baseUrl).toString();
	const html = await fetchEventDetailHtml(pageUrl, options?.browser, { useBrowser: false });
	const media = parseWebflowEventMedia(html);

	let imageUrl = media.image_url ?? event.image_url;
	if (!imageUrl || !/ticketm\.net/i.test(imageUrl)) {
		const ticketUrl = media.ticket_url ?? event.ticket_url;
		const tmImage = await resolveTicketmasterImageFromUrl(ticketUrl, options?.ticketmasterApiKey);
		if (tmImage) imageUrl = tmImage;
	}

	return {
		...event,
		image_url: imageUrl,
		ticket_url: media.ticket_url ?? event.ticket_url,
		youtube_embed: media.youtube_embed ?? event.youtube_embed,
		youtube_id: media.youtube_id ?? event.youtube_id,
	};
}

function listingCardToPartnerEvent(
	card: WebflowListingCard,
	baseUrl: string,
	venueName: string,
	address: string | null,
	timezone: string,
): PartnerEvent | null {
	let startsAt: string;
	try {
		startsAt = localWallTimeToUtcIso(`${card.datePart} ${card.clock}`, timezone);
	} catch {
		return null;
	}

	const pageUrl = new URL(`/events/${card.slug}`, baseUrl).toString();
	return toPartnerEvent({
		title: card.title,
		starts_at: startsAt,
		venue_name: venueName,
		address,
		image_url: card.imageUrl,
		source_url: card.ticketUrl ?? pageUrl,
		source_partner: "webflow",
		source_event_id: card.slug,
		raw_date_text: `${card.datePart} ${card.clock}`,
		ticket_url: card.ticketUrl,
		confidence: 1,
	});
}

export function parseWebflowListingCards(html: string): WebflowListingCard[] {
	const cards: WebflowListingCard[] = [];
	const seen = new Set<string>();

	for (const match of html.matchAll(/href=["']\/events\/([^"'#?]+)["']/gi)) {
		const slug = match[1];
		if (seen.has(slug)) continue;
		seen.add(slug);

		const chunk = html.slice(match.index ?? 0, (match.index ?? 0) + 1800);
		const textLines = chunk
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<[^>]+>/g, "\n")
			.split("\n")
			.map((line) => line.replace(/&amp;/g, "&").trim())
			.filter((line) => line.length > 1);

		const dateLine = textLines.find((line) =>
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i.test(
				line,
			),
		);
		const timeLine = textLines.find((line) => /\d{1,2}:\d{2}\s*(?:am|pm)/i.test(line));
		if (!dateLine || !timeLine) continue;

		const datePart = parseDisplayDate(dateLine);
		const clock = parseClock(timeLine);
		if (!datePart || !clock) continue;

		const dateIdx = textLines.indexOf(dateLine);
		const timeIdx = textLines.indexOf(timeLine);
		const title =
			textLines
				.slice(dateIdx + 1, timeIdx)
				.find((line) => !/^(buy|tickets|free event|jul|feb|mar|apr|may|jun|aug|sep|oct|nov|dec)$/i.test(line)) ??
			slug.replace(/-/g, " ");

		const ticketUrl = extractListingTicketUrl(chunk);
		const imageUrl =
			chunk.match(/background-image:url\(&quot;(https:\/\/cdn\.prod\.website-files\.com[^&]+)&quot;\)/i)?.[1] ??
			chunk.match(/<img[^>]+src=["'](https:\/\/cdn\.prod\.website-files\.com[^"']+)["']/i)?.[1] ??
			null;

		cards.push({ slug, title, datePart, clock, ticketUrl, imageUrl });
	}

	return cards;
}

async function parseEventPage(
	baseUrl: string,
	slug: string,
	venueName: string,
	address: string | null,
	timezone: string,
	browser?: CloudflareEnv["BROWSER"],
	ticketmasterApiKey?: string | null,
): Promise<PartnerEvent | null> {
	const pageUrl = new URL(`/events/${slug}`, baseUrl).toString();
	const html = await fetchEventDetailHtml(pageUrl, browser);

	const title =
		html
			.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
			?.replace(/<[^>]+>/g, "")
			.trim() ??
		html.match(/class=["'][^"']*column-11 left[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]?.replace(/<[^>]+>/g, "").trim();

	const dateTimeContainer = html.match(/class=["'][^"']*date-time-container[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1];
	const datePart = parseDisplayDate(dateTimeContainer ?? html) ?? parseDisplayDate(html);
	if (!title || !datePart) return null;

	const doors = parseClock(html.match(/Doors at[\s\S]{0,120}?(\d{1,2}:\d{2}\s*(?:am|pm))/i)?.[1] ?? "");
	const containerClock = dateTimeContainer ? parseClock(dateTimeContainer) : null;
	const show = containerClock ?? parseClock(html.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i)?.[1] ?? "");
	const clock = show ?? doors ?? "20:00:00";

	let startsAt: string;
	try {
		startsAt = localWallTimeToUtcIso(`${datePart} ${clock}`, timezone);
	} catch {
		return null;
	}

	const media = parseWebflowEventMedia(html);
	let imageUrl = media.image_url;
	if (!imageUrl || !/ticketm\.net/i.test(imageUrl)) {
		const tmImage = await resolveTicketmasterImageFromUrl(media.ticket_url, ticketmasterApiKey);
		if (tmImage) imageUrl = tmImage;
	}

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		venue_name: venueName,
		address,
		image_url: imageUrl,
		source_url: media.ticket_url ?? pageUrl,
		source_partner: "webflow",
		source_event_id: slug,
		raw_date_text: datePart,
		ticket_url: media.ticket_url,
		youtube_embed: media.youtube_embed,
		youtube_id: media.youtube_id,
		confidence: 1,
	});
}

export async function fetchWebflowEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxEvents?: number;
	browser?: CloudflareEnv["BROWSER"];
	ticketmasterApiKey?: string | null;
}): Promise<PartnerEvent[]> {
	if (!isWebflowEventsPage(params.calendarHtml, params.calendarUrl)) {
		throw new Error("Page does not look like a Webflow events listing");
	}

	const baseUrl = new URL(params.calendarUrl).origin;
	const cutoff = Date.now() + params.scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const maxEvents = params.maxEvents ?? 40;
	const mediaOptions = {
		browser: params.browser,
		ticketmasterApiKey: params.ticketmasterApiKey,
	};

	const listingHtml = await fetchWebflowListingHtml(params.calendarUrl, params.calendarHtml);
	const listingCards = parseWebflowListingCards(listingHtml);
	if (listingCards.length >= 3) {
		const events: PartnerEvent[] = [];
		const seen = new Set<string>();
		for (const card of listingCards) {
			const event = listingCardToPartnerEvent(card, baseUrl, params.venueName, params.address, params.timezone);
			if (!event) continue;
			if (new Date(event.starts_at).getTime() > cutoff) continue;
			const key = `${event.source_event_id}|${event.starts_at}`;
			if (seen.has(key)) continue;
			seen.add(key);
			events.push(event);
		}
		if (events.length > 0) {
			const enriched: PartnerEvent[] = [];
			for (const event of events.slice(0, maxEvents)) {
				enriched.push(await enrichWebflowEventMedia(event, baseUrl, mediaOptions));
			}
			return enriched.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
		}
	}

	const slugs = extractWebflowEventSlugs(listingHtml).slice(0, maxEvents);
	const events: PartnerEvent[] = [];
	for (const slug of slugs) {
		const event = await parseEventPage(
			baseUrl,
			slug,
			params.venueName,
			params.address,
			params.timezone,
			params.browser,
			params.ticketmasterApiKey,
		);
		if (!event) continue;
		if (new Date(event.starts_at).getTime() > cutoff) continue;
		events.push(event);
	}
	return events;
}