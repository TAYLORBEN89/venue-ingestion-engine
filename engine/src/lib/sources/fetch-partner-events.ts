import { renderMarkdown } from "../browser";
import { extractEvents } from "../extract";
import { toPartnerEvent, type FeedType, type PartnerEvent } from "../normalize";
import { coalesceTicketUrl, extractTicketUrlFromMarkdown } from "../ticket-links";
import { discoverFeedUrlFromHtml, resolveFeedType, toFetchableUrl } from "./discover";
import { detectPlatformFromHtml } from "./detect-platform";
import { extractEventDiscoveryConfig, fetchEventDiscoveryEvents } from "./event-discovery";
import { fetchPageText } from "./fetch-page";
import {
	extractPrekindleOrganizerId,
	fetchPrekindleEvents,
	isPrekindleCalendar,
} from "./prekindle";
import { fetchMecEvents, isMecCalendar } from "./mec";
import { fetchSeatEngineEvents, isSeatEngineCalendar } from "./seatengine";
import { fetchEventOnEvents, isEventOnCalendar } from "./eventon";
import { fetchTecEvents, isTecCalendar } from "./tec";
import { fetchZoogleEvents, isZoogleCalendar } from "./zoogle-calendar";
import { fetchLiveNationEvents, isLiveNationSite } from "./livenation";
import { fetchEsthersFolliesEvents, isEsthersFollies } from "./esthers-follies";
import { fetchWebflowEvents, isWebflowEventsPage } from "./webflow-events";
import {
	fetchSquarespaceUserItemsEvents,
	isSquarespaceUserItemsList,
} from "./squarespace-user-items";
import {
	fetchSquarespaceEvents,
	isSquarespaceEventsCalendar,
} from "./squarespace-events";
import { fetchAceCalendarEvents, isAceCalendar } from "./ace-calendar";
import { fetchHeyAustinEvents, isHeyAustinSource } from "./heyaustin";
import { fetchLakeTravisEvents, isLakeTravisSource } from "./laketravis";
import { fetchSpacecraftedEvents, isSpacecraftedCalendar } from "./spacecrafted";
import { fetchSpotAppsEvents, isSpotAppsCalendar } from "./spotapps";
import { fetchEventsManagerEvents, isEventsManagerCalendar } from "./events-manager";
import { fetchOuthouseTicketsEvents, isOuthouseTicketsCalendar } from "./outhousetickets";
import { fetchGermaniaAmpEvents, isGermaniaAmpCalendar } from "./germania-amp";
import { fetchCotaEvents, isCotaEventsCalendar } from "./cota-events";
import { fetchVulcanAtxEvents, isVulcanAtxCalendar } from "./vulcan-atx";
import {
	fetchComedyMothershipEvents,
	isComedyMothership,
} from "./comedy-mothership";
import { fetchDocsDriveInEvents, isDocsDriveIn } from "./docs-drive-in";
import { fetchWhiteHorseEvents, isWhiteHorse } from "./white-horse";
import { enrichIcalEventMedia } from "./enrich-ical-media";
import { parseIcalFeed } from "./ical";

export interface VenueSourceConfig {
	name: string;
	address: string | null;
	website_url?: string | null;
	calendar_url: string | null;
	event_feed_url: string | null;
	event_feed_type: FeedType | null;
	/** Explicit platform from venue_event_sources.platform_type when set */
	platform_type?: string | null;
}

export interface FetchPartnerEventsParams {
	browser: CloudflareEnv["BROWSER"];
	ai?: CloudflareEnv["AI"];
	enableAiScrapeFallback: boolean;
	timezone: string;
	scrapeDaysAhead?: number;
	ticketmasterApiKey?: string | null;
	venue: VenueSourceConfig;
	/**
	 * Partner listing ids already published (SeatEngine /events/{id}).
	 * Detail pages for these are skipped; the full calendar is still scanned for new ids.
	 */
	knownPartnerEventIds?: string[] | null;
	/** Force full SeatEngine crawl even when known ids exist (pilot retrain). */
	forceFullSeatEngineScan?: boolean;
}

async function fetchText(url: string): Promise<string> {
	return fetchPageText(url);
}

async function parseFeed(
	feedUrl: string,
	feedType: FeedType,
	venue: VenueSourceConfig,
	ticketmasterApiKey?: string | null,
): Promise<PartnerEvent[]> {
	const text = await fetchText(feedUrl);
	const resolved = resolveFeedType(feedType, feedUrl);

	if (resolved === "ical" || resolved === "google_calendar") {
		const icalEvents = parseIcalFeed(text, {
			venueName: venue.name,
			address: venue.address,
			sourceUrl: feedUrl,
			sourcePartner: resolved,
		});
		return enrichIcalEventMedia(icalEvents, {
			maxFetches: 30,
			ticketmasterApiKey,
		});
	}

	throw new Error(`Feed type "${resolved}" is not implemented yet for ${feedUrl}`);
}

async function discoverAndParseFeed(
	venue: VenueSourceConfig,
	timezone: string,
	scrapeDaysAhead: number,
	options: Pick<
		FetchPartnerEventsParams,
		"browser" | "ticketmasterApiKey" | "knownPartnerEventIds" | "forceFullSeatEngineScan"
	>,
): Promise<PartnerEvent[]> {
	const pageUrl = venue.event_feed_url ?? venue.calendar_url;
	if (!pageUrl) {
		throw new Error("No calendar_url or event_feed_url configured");
	}

	// White Horse BEFORE generic feed detect: broker feed_url contains
	// group.calendar.google.com which false-matches as iCal/google_calendar.
	if (
		venue.platform_type === "white_horse" ||
		isWhiteHorse(pageUrl) ||
		isWhiteHorse(venue.calendar_url || "") ||
		isWhiteHorse(venue.event_feed_url || "")
	) {
		return fetchWhiteHorseEvents({
			calendarUrl: venue.calendar_url || "https://www.thewhitehorseaustin.com/",
			feedUrl: venue.event_feed_url || pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 90),
			maxEvents: 150,
		});
	}

	const explicitType = venue.event_feed_type ?? "auto";
	const directType = resolveFeedType(explicitType, pageUrl);
	if (directType !== "scrape") {
		return parseFeed(pageUrl, explicitType, venue, options.ticketmasterApiKey);
	}

	// Comedy Mothership: bare fetch hits Vercel Security Checkpoint (429).
	// Route by URL / stored platform before fetchText so Browser Rendering can run.
	if (
		venue.platform_type === "comedy_mothership" ||
		isComedyMothership(pageUrl)
	) {
		return fetchComedyMothershipEvents({
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			maxPages: 12,
			browser: options.browser,
		});
	}

	// Doc's Drive-In: JSON /api/events + FullCalendar detail pages (no browser).
	if (venue.platform_type === "docs_drive_in" || isDocsDriveIn(pageUrl)) {
		return fetchDocsDriveInEvents({
			calendarUrl: pageUrl.includes("event-calendar")
				? pageUrl
				: "https://www.docsdriveintheatre.com/events/event-calendar",
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			maxEvents: 80,
		});
	}

	const html = await fetchText(pageUrl);
	const detected = detectPlatformFromHtml(html, pageUrl);
	// Prefer stored platform when HTML is a captcha/WAF shell (no tribe-* markers).
	const platform =
		venue.platform_type && venue.platform_type !== "auto" ? venue.platform_type : detected;

	// HeyAustin before other WP event plugins (listing pages share admin-ajax noise).
	if (platform === "heyaustin" || isHeyAustinSource(pageUrl)) {
		return fetchHeyAustinEvents({
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			websiteUrl: venue.website_url,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
		});
	}

	// Lake Travis Listar city event feed filtered by venue name (not HeyAustin).
	if (platform === "laketravis" || isLakeTravisSource(pageUrl)) {
		return fetchLakeTravisEvents({
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			websiteUrl: venue.website_url,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
		});
	}

	// EventON before Event Discovery: both are WP plugins; EventON 5 pages carry a generic
	// "nonce" that used to false-match discovery and 400 on admin-ajax (Donn's Depot).
	if (platform === "eventon" || isEventOnCalendar(html, pageUrl)) {
		return fetchEventOnEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			maxEvents: 80,
		});
	}

	if (platform === "event_discovery" || extractEventDiscoveryConfig(html)) {
		return fetchEventDiscoveryEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead,
		});
	}

	if (platform === "webflow" || isWebflowEventsPage(html, pageUrl)) {
		return fetchWebflowEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead,
			maxEvents: 15,
			browser: options.browser,
			ticketmasterApiKey: options.ticketmasterApiKey,
		});
	}

	if (platform === "seatengine" || isSeatEngineCalendar(html, pageUrl)) {
		// Cap City: batch size keeps CF workflows under timeout; multi-run fills the rest
		const isCapCityGrid = /capcitycomedy\.com|se-calendar/i.test(`${pageUrl}\n${html}`);
		const maxShows = isCapCityGrid ? 22 : 40;
		return fetchSeatEngineEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead,
			maxShows,
			websiteUrl: venue.website_url,
			// Skip already-published / staged listings; still scan full calendar for new mid-range ids
			knownEventIds: options.knownPartnerEventIds ?? null,
			forceFullScan: options.forceFullSeatEngineScan === true,
		});
	}

	if (platform === "mec" || isMecCalendar(html, pageUrl)) {
		return fetchMecEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead,
			maxEvents: 20,
		});
	}

	if (platform === "tec" || isTecCalendar(html, pageUrl) || isTecCalendar("", pageUrl)) {
		return fetchTecEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			// Saxon-style denser calendars list 6–12 months out; don't clip early.
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 400),
			maxEvents: 500,
			browser: options.browser,
		});
	}

	if (platform === "zoogle" || isZoogleCalendar(html, pageUrl)) {
		return fetchZoogleEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead,
			maxPages: 7,
		});
	}

	if (platform === "livenation" || isLiveNationSite(html, pageUrl)) {
		return fetchLiveNationEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 180),
			browser: options.browser,
			websiteUrl: venue.website_url,
		});
	}

	if (platform === "esthers_follies" || isEsthersFollies(pageUrl)) {
		return fetchEsthersFolliesEvents({
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.min(scrapeDaysAhead, 60),
		});
	}

	if (
		platform === "squarespace_events" ||
		isSquarespaceEventsCalendar(html, pageUrl)
	) {
		return fetchSquarespaceEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
		});
	}

	if (
		platform === "squarespace_user_items" ||
		isSquarespaceUserItemsList(html, pageUrl)
	) {
		return fetchSquarespaceUserItemsEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 180),
		});
	}

	// ACE Calendar (ZACH Theatre etc.) — LIST view layout=B; browser needed for SPA events.
	// DB check constraint may not allow platform_type=ace_calendar; use custom_html + URL/HTML detect.
	if (platform === "ace_calendar" || isAceCalendar(html, pageUrl)) {
		return fetchAceCalendarEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			browser: options.browser,
			maxProductions: 12,
		});
	}

	if (
		platform === "prekindle" ||
		isPrekindleCalendar(html, pageUrl) ||
		extractPrekindleOrganizerId(html)
	) {
		const events = await fetchPrekindleEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			// Promo pages: flyer + RSVP HERE checkout (HITW walkthrough)
			enrichPromoPages: true,
			maxEnrich: Math.min(Math.max(scrapeDaysAhead, 40), 80),
		});
		const now = Date.now() - 60 * 60 * 1000;
		const cutoff = Date.now() + scrapeDaysAhead * 24 * 60 * 60 * 1000;
		return events.filter((e) => {
			const t = new Date(e.starts_at).getTime();
			return t >= now && t <= cutoff;
		});
	}

	if (platform === "spacecrafted" || isSpacecraftedCalendar(html, pageUrl)) {
		return fetchSpacecraftedEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 60),
			maxEvents: 80,
			enrichDetails: true,
		});
	}

	if (platform === "spotapps" || isSpotAppsCalendar(html, pageUrl)) {
		return fetchSpotAppsEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 90),
		});
	}

	if (platform === "events_manager" || isEventsManagerCalendar(html, pageUrl)) {
		return fetchEventsManagerEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			browser: options.browser,
		});
	}

	if (platform === "outhousetickets" || isOuthouseTicketsCalendar(html, pageUrl)) {
		return fetchOuthouseTicketsEvents({
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
		});
	}

	if (platform === "germania_amp" || isGermaniaAmpCalendar(html, pageUrl)) {
		return fetchGermaniaAmpEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 200),
			enrichDetails: true,
			maxEvents: 40,
		});
	}

	// Vulcan: Webflow CMS homepage list + TicketSauce.
	// Prefer URL/HTML detect so DB can store custom_html if vulcan_atx isn't in check constraint.
	if (platform === "vulcan_atx" || isVulcanAtxCalendar(html, pageUrl)) {
		return fetchVulcanAtxEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			maxEvents: 80,
		});
	}

	// Comedy Mothership: Next.js EventCard grid + ?page=N (needs browser past Vercel WAF).
	if (
		platform === "comedy_mothership" ||
		isComedyMothership(pageUrl, html) ||
		isComedyMothership(pageUrl)
	) {
		return fetchComedyMothershipEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			maxPages: 12,
			browser: options.browser,
		});
	}

	// Doc's Drive-In after HTML fetch (detect from page markers too).
	if (platform === "docs_drive_in" || isDocsDriveIn(pageUrl, html)) {
		return fetchDocsDriveInEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 120),
			maxEvents: 80,
		});
	}

	// White Horse after HTML (eventscalendar iframe markers).
	if (platform === "white_horse" || isWhiteHorse(pageUrl, html)) {
		return fetchWhiteHorseEvents({
			calendarUrl: pageUrl,
			feedUrl: venue.event_feed_url,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 90),
			maxEvents: 150,
		});
	}

	if (platform === "cota" || isCotaEventsCalendar(html, pageUrl)) {
		return fetchCotaEvents({
			calendarHtml: html,
			calendarUrl: pageUrl,
			venueName: venue.name,
			address: venue.address,
			timezone,
			scrapeDaysAhead: Math.max(scrapeDaysAhead, 400),
			maxEvents: 50,
		});
	}

	const discovered = discoverFeedUrlFromHtml(html, pageUrl);
	if (discovered) {
		return parseFeed(discovered, "auto", venue, options.ticketmasterApiKey);
	}

	return [];
}

async function scrapeWithAi(params: FetchPartnerEventsParams): Promise<PartnerEvent[]> {
	if (!params.ai) throw new Error("AI binding required for scrape fallback");
	const calendarUrl = params.venue.calendar_url;
	if (!calendarUrl) throw new Error("No calendar_url for scrape fallback");

	const content = await renderMarkdown(params.browser, calendarUrl);
	const extracted = await extractEvents({
		ai: params.ai,
		venueName: params.venue.name,
		timezone: params.timezone,
		sourceUrl: calendarUrl,
		content,
	});

	return extracted
		.map((event) => {
			const ticketUrl = coalesceTicketUrl(
				event.ticket_url,
				extractTicketUrlFromMarkdown(content, event.raw_title),
			);
			return toPartnerEvent({
				title: event.raw_title,
				starts_at: event.parsed_starts_at ?? "",
				ends_at: event.parsed_ends_at,
				venue_name: params.venue.name,
				address: params.venue.address,
				description: event.description,
				image_url: event.image_url,
				source_url: ticketUrl ?? calendarUrl,
				source_partner: "ai_scrape",
				raw_date_text: event.raw_date_text,
				price_text: event.price_text,
				ticket_url: ticketUrl,
				confidence: event.confidence,
			});
		})
		.filter((event) => event.starts_at.length > 0);
}

/**
 * Feed-first partner import:
 * 1. event_feed_url (or iCal link discovered on calendar_url page)
 * 2. optional AI scrape fallback when no structured feed exists
 */
export async function fetchPartnerEvents(params: FetchPartnerEventsParams): Promise<{
	events: PartnerEvent[];
	method: "feed" | "ai_scrape" | "none";
}> {
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 90;
	const feedEvents = await discoverAndParseFeed(params.venue, params.timezone, scrapeDaysAhead, {
		browser: params.browser,
		ticketmasterApiKey: params.ticketmasterApiKey,
		knownPartnerEventIds: params.knownPartnerEventIds,
		forceFullSeatEngineScan: params.forceFullSeatEngineScan,
	});
	if (feedEvents.length > 0) {
		return { events: feedEvents, method: "feed" };
	}

	if (params.enableAiScrapeFallback && params.venue.calendar_url) {
		const scraped = await scrapeWithAi(params);
		return { events: scraped, method: "ai_scrape" };
	}

	if (!params.venue.calendar_url && !params.venue.event_feed_url) {
		throw new Error(`Venue ${params.venue.name} has no event source configured`);
	}

	throw new Error(
		`No structured feed found for ${params.venue.name}. ` +
			`Set event_feed_url (iCal/API) or enable AI scrape fallback.`,
	);
}