import { renderMarkdown } from "../browser";
import { detectFeedTypeFromUrl, discoverFeedUrlFromHtml } from "./discover";
import { detectPlatformFromHtml, platformLabel, type PlatformType, toFeedType } from "./detect-platform";
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
import { fetchSpacecraftedEvents, isSpacecraftedCalendar } from "./spacecrafted";
import { fetchSpotAppsEvents, isSpotAppsCalendar } from "./spotapps";
import { fetchEventsManagerEvents, isEventsManagerCalendar } from "./events-manager";
import { fetchOuthouseTicketsEvents, isOuthouseTicketsCalendar } from "./outhousetickets";
import { fetchCotaEvents, isCotaEventsCalendar } from "./cota-events";
import { fetchGermaniaAmpEvents, isGermaniaAmpCalendar } from "./germania-amp";
import { fetchVulcanAtxEvents, isVulcanAtxCalendar } from "./vulcan-atx";
import {
	fetchComedyMothershipEvents,
	isComedyMothership,
} from "./comedy-mothership";
import { fetchDocsDriveInEvents, isDocsDriveIn } from "./docs-drive-in";
import { fetchWhiteHorseEvents, isWhiteHorse } from "./white-horse";
import { parseIcalFeed } from "./ical";
import { extractTicketUrlFromMarkdown } from "../ticket-links";

export interface TestSourceResult {
	calendar_url: string;
	detected_platform: PlatformType;
	platform_label: string;
	feed_url: string | null;
	events_found: number;
	has_ticket_links: boolean;
	has_images: boolean;
	ready: boolean;
	messages: string[];
	sample_titles: string[];
}

async function fetchText(url: string): Promise<string> {
	return fetchPageText(url);
}

function filterByDaysAhead<T extends { starts_at: string }>(events: T[], daysAhead: number): T[] {
	const cutoff = Date.now() + daysAhead * 24 * 60 * 60 * 1000;
	return events.filter((e) => new Date(e.starts_at).getTime() <= cutoff);
}

export async function testVenueSource(params: {
	browser: CloudflareEnv["BROWSER"];
	calendarUrl: string;
	feedUrl?: string | null;
	platformType?: PlatformType;
	scrapeDaysAhead?: number;
	ticketmasterApiKey?: string | null;
	venueName: string;
	venueAddress?: string | null;
}): Promise<TestSourceResult> {
	const messages: string[] = [];
	const daysAhead = params.scrapeDaysAhead ?? 90;

	// The White Horse: Events Calendar → Google broker API (no browser).
	const whiteHorseHint =
		params.platformType === "white_horse" || isWhiteHorse(params.calendarUrl);
	if (whiteHorseHint) {
		try {
			const events = filterByDaysAhead(
				await fetchWhiteHorseEvents({
					calendarUrl: params.calendarUrl,
					feedUrl: params.feedUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					scrapeDaysAhead: Math.max(daysAhead, 90),
					maxEvents: 150,
				}),
				Math.max(daysAhead, 90),
			);
			return {
				calendar_url: params.calendarUrl,
				detected_platform: "white_horse",
				platform_label: platformLabel("white_horse"),
				feed_url:
					"https://broker.eventscalendar.co/api/google/events (whitehorse confirmed shows)",
				events_found: events.length,
				has_ticket_links: events.some((e) => Boolean(e.ticket_url)),
				has_images: events.some((e) => Boolean(e.image_url)),
				ready: events.length > 0,
				messages: [
					`Parsed ${events.length} White Horse shows from Events Calendar Google sync (titles/times only; cover-charge rows skipped; next ${Math.max(daysAhead, 90)} days).`,
				],
				sample_titles: events.slice(0, 8).map((e) => e.title),
			};
		} catch (err) {
			return {
				calendar_url: params.calendarUrl,
				detected_platform: "white_horse",
				platform_label: platformLabel("white_horse"),
				feed_url: null,
				events_found: 0,
				has_ticket_links: false,
				has_images: false,
				ready: false,
				messages: [
					`White Horse parse failed: ${err instanceof Error ? err.message : String(err)}`,
				],
				sample_titles: [],
			};
		}
	}

	// Doc's Drive-In: JSON /api/events (no browser).
	const docsDriveInHint =
		params.platformType === "docs_drive_in" || isDocsDriveIn(params.calendarUrl);
	if (docsDriveInHint) {
		try {
			const events = filterByDaysAhead(
				await fetchDocsDriveInEvents({
					calendarUrl: params.calendarUrl.includes("event-calendar")
						? params.calendarUrl
						: "https://www.docsdriveintheatre.com/events/event-calendar",
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
					maxEvents: 80,
				}),
				Math.max(daysAhead, 120),
			);
			return {
				calendar_url: params.calendarUrl,
				detected_platform: "docs_drive_in",
				platform_label: platformLabel("docs_drive_in"),
				feed_url: "https://www.docsdriveintheatre.com/api/events",
				events_found: events.length,
				has_ticket_links: events.some((e) => Boolean(e.ticket_url)),
				has_images: events.some((e) => Boolean(e.image_url)),
				ready: events.length > 0,
				messages: [
					`Parsed ${events.length} Doc's Drive-In shows from /api/events (+ FullCalendar detail URLs; next ${Math.max(daysAhead, 120)} days).`,
				],
				sample_titles: events.slice(0, 8).map((e) => e.title),
			};
		} catch (err) {
			return {
				calendar_url: params.calendarUrl,
				detected_platform: "docs_drive_in",
				platform_label: platformLabel("docs_drive_in"),
				feed_url: "https://www.docsdriveintheatre.com/api/events",
				events_found: 0,
				has_ticket_links: false,
				has_images: false,
				ready: false,
				messages: [
					`Doc's Drive-In parse failed: ${err instanceof Error ? err.message : String(err)}`,
				],
				sample_titles: [],
			};
		}
	}

	// Comedy Mothership: Vercel WAF blocks bare fetch — test via Browser Rendering.
	const mothershipHint =
		params.platformType === "comedy_mothership" ||
		isComedyMothership(params.calendarUrl);
	if (mothershipHint) {
		try {
			const events = filterByDaysAhead(
				await fetchComedyMothershipEvents({
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
					maxPages: 12,
					browser: params.browser,
				}),
				Math.max(daysAhead, 120),
			);
			return {
				calendar_url: params.calendarUrl,
				detected_platform: "comedy_mothership",
				platform_label: platformLabel("comedy_mothership"),
				feed_url: null,
				events_found: events.length,
				has_ticket_links: events.some((e) => Boolean(e.ticket_url)),
				has_images: events.some((e) => Boolean(e.image_url)),
				ready: events.length > 0,
				messages: [
					`Parsed ${events.length} Comedy Mothership shows from /shows grid (all pages; next ${Math.max(daysAhead, 120)} days). Browser required past Vercel checkpoint.`,
				],
				sample_titles: events.slice(0, 8).map((e) => e.title),
			};
		} catch (err) {
			return {
				calendar_url: params.calendarUrl,
				detected_platform: "comedy_mothership",
				platform_label: platformLabel("comedy_mothership"),
				feed_url: null,
				events_found: 0,
				has_ticket_links: false,
				has_images: false,
				ready: false,
				messages: [
					`Comedy Mothership parse failed: ${err instanceof Error ? err.message : String(err)}`,
				],
				sample_titles: [],
			};
		}
	}

	let html = "";
	try {
		html = await fetchText(params.calendarUrl);
	} catch (err) {
		throw new Error(`Could not fetch calendar page: ${err instanceof Error ? err.message : String(err)}`);
	}

	const detected =
		params.platformType && params.platformType !== "auto"
			? params.platformType
			: detectPlatformFromHtml(html, params.calendarUrl);

	const discoveredFeed = params.feedUrl ?? discoverFeedUrlFromHtml(html, params.calendarUrl);
	if (discoveredFeed) {
		messages.push(`Discovered feed: ${discoveredFeed}`);
	}

	let eventsFound = 0;
	const sampleTitles: string[] = [];
	let hasTicketLinks = false;
	let hasImages = false;

	const heyaustin = detected === "heyaustin" || isHeyAustinSource(params.calendarUrl);
	const eventDiscovery =
		!heyaustin &&
		(detected === "event_discovery" || Boolean(extractEventDiscoveryConfig(html)));
	const webflow = detected === "webflow" || isWebflowEventsPage(html, params.calendarUrl);
	const seatengine = detected === "seatengine" || isSeatEngineCalendar(html, params.calendarUrl);
	const eventon = detected === "eventon" || isEventOnCalendar(html, params.calendarUrl);
	const mec = detected === "mec" || isMecCalendar(html, params.calendarUrl);
	const tec = detected === "tec" || isTecCalendar(html, params.calendarUrl);
	const zoogle = detected === "zoogle" || isZoogleCalendar(html, params.calendarUrl);
	const livenation = detected === "livenation" || isLiveNationSite(html, params.calendarUrl);
	const esthers = detected === "esthers_follies" || isEsthersFollies(params.calendarUrl);
	const ace = detected === "ace_calendar" || isAceCalendar(html, params.calendarUrl);
	const spacecrafted =
		detected === "spacecrafted" || isSpacecraftedCalendar(html, params.calendarUrl);
	const spotapps = detected === "spotapps" || isSpotAppsCalendar(html, params.calendarUrl);
	const eventsManager =
		detected === "events_manager" || isEventsManagerCalendar(html, params.calendarUrl);
	const outhousetickets =
		detected === "outhousetickets" || isOuthouseTicketsCalendar(html, params.calendarUrl);
	const cota = detected === "cota" || isCotaEventsCalendar(html, params.calendarUrl);
	const germaniaAmp =
		detected === "germania_amp" || isGermaniaAmpCalendar(html, params.calendarUrl);
	const vulcanAtx =
		detected === "vulcan_atx" || isVulcanAtxCalendar(html, params.calendarUrl);
	const comedyMothership =
		detected === "comedy_mothership" || isComedyMothership(params.calendarUrl, html);
	const docsDriveIn =
		detected === "docs_drive_in" || isDocsDriveIn(params.calendarUrl, html);
	const whiteHorse = detected === "white_horse" || isWhiteHorse(params.calendarUrl, html);
	const squarespaceEvents =
		detected === "squarespace_events" ||
		isSquarespaceEventsCalendar(html, params.calendarUrl);
	const squarespaceUserItems =
		!squarespaceEvents &&
		(detected === "squarespace_user_items" ||
			isSquarespaceUserItemsList(html, params.calendarUrl));
	const prekindleOrganizerId = extractPrekindleOrganizerId(html);
	const prekindle =
		detected === "prekindle" ||
		isPrekindleCalendar(html, params.calendarUrl) ||
		Boolean(prekindleOrganizerId);
	const resolvedPlatform: PlatformType = heyaustin
		? "heyaustin"
		: whiteHorse
			? "white_horse"
			: docsDriveIn
				? "docs_drive_in"
				: comedyMothership
					? "comedy_mothership"
					: cota
						? "cota"
						: germaniaAmp
							? "germania_amp"
							: vulcanAtx
								? "vulcan_atx"
								: eventDiscovery
									? "event_discovery"
									: webflow
										? "webflow"
										: seatengine
											? "seatengine"
											: eventon
												? "eventon"
												: mec
													? "mec"
													: tec
														? "tec"
														: zoogle
															? "zoogle"
															: livenation
																? "livenation"
																: esthers
																	? "esthers_follies"
																	: ace
																		? "ace_calendar"
																		: spacecrafted
																			? "spacecrafted"
																			: spotapps
																				? "spotapps"
																				: eventsManager
																					? "events_manager"
																					: outhousetickets
																						? "outhousetickets"
																						: squarespaceEvents
																							? "squarespace_events"
																							: squarespaceUserItems
																								? "squarespace_user_items"
																								: prekindle
																									? "prekindle"
																									: detected;

	if (heyaustin) {
		try {
			const events = filterByDaysAhead(
				await fetchHeyAustinEvents({
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: daysAhead,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from HeyAustin Listar feed for this listing (next ${daysAhead} days).`,
			);
			if (eventsFound === 0) {
				messages.push(
					"HeyAustin listing resolved, but no facebook_events are tagged to this venue name/website in the city feed.",
				);
			}
		} catch (err) {
			messages.push(`HeyAustin parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (cota) {
		try {
			const events = filterByDaysAhead(
				await fetchCotaEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 365),
					maxEvents: 50,
				}),
				Math.max(daysAhead, 365),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 8).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} COTA events from list layout (Concerts/Germania skipped; next ${Math.max(daysAhead, 365)} days).`,
			);
		} catch (err) {
			messages.push(`COTA parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (germaniaAmp) {
		try {
			const events = filterByDaysAhead(
				await fetchGermaniaAmpEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 200),
					enrichDetails: true,
					maxEvents: 40,
				}),
				Math.max(daysAhead, 200),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 8).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} Germania Amp shows (card list + detail enrich; next ${Math.max(daysAhead, 200)} days).`,
			);
		} catch (err) {
			messages.push(
				`Germania Amp parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (whiteHorse) {
		try {
			const events = filterByDaysAhead(
				await fetchWhiteHorseEvents({
					calendarUrl: params.calendarUrl,
					feedUrl: params.feedUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					scrapeDaysAhead: Math.max(daysAhead, 90),
					maxEvents: 150,
				}),
				Math.max(daysAhead, 90),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 8).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} White Horse shows from Events Calendar Google sync (next ${Math.max(daysAhead, 90)} days).`,
			);
		} catch (err) {
			messages.push(
				`White Horse parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (docsDriveIn) {
		try {
			const events = filterByDaysAhead(
				await fetchDocsDriveInEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
					maxEvents: 80,
				}),
				Math.max(daysAhead, 120),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 8).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} Doc's Drive-In shows from /api/events (FullCalendar detail URLs; next ${Math.max(daysAhead, 120)} days).`,
			);
		} catch (err) {
			messages.push(
				`Doc's Drive-In parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (vulcanAtx) {
		try {
			const events = filterByDaysAhead(
				await fetchVulcanAtxEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
					maxEvents: 80,
				}),
				Math.max(daysAhead, 120),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 8).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} Vulcan Gas Company shows (homepage CMS + TicketSauce; next ${Math.max(daysAhead, 120)} days).`,
			);
		} catch (err) {
			messages.push(
				`Vulcan ATX parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (eventDiscovery) {
		try {
			const events = await fetchEventDiscoveryEvents({
				calendarHtml: html,
				calendarUrl: params.calendarUrl,
				venueName: params.venueName,
				address: params.venueAddress ?? null,
				timezone: "America/Chicago",
				scrapeDaysAhead: daysAhead,
			});
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(`Parsed ${eventsFound} events from Event Discovery API (next ${daysAhead} days).`);
		} catch (err) {
			messages.push(`Event Discovery parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (webflow) {
		try {
			const events = await fetchWebflowEvents({
				calendarHtml: html,
				calendarUrl: params.calendarUrl,
				venueName: params.venueName,
				address: params.venueAddress ?? null,
				timezone: "America/Chicago",
				scrapeDaysAhead: daysAhead,
				maxEvents: 10,
				browser: params.browser,
				ticketmasterApiKey: params.ticketmasterApiKey,
			});
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(`Parsed ${eventsFound} events from Webflow listing pages (next ${daysAhead} days).`);
		} catch (err) {
			messages.push(`Webflow parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (seatengine) {
		try {
			// Cap City multi-month /events grid needs more than classic /shows scrapes
			const maxShows = /capcitycomedy\.com|se-calendar/i.test(
				`${params.calendarUrl}\n${html}`,
			)
				? 40
				: 15;
			const events = await fetchSeatEngineEvents({
				calendarHtml: html,
				calendarUrl: params.calendarUrl,
				venueName: params.venueName,
				address: params.venueAddress ?? null,
				timezone: "America/Chicago",
				scrapeDaysAhead: daysAhead,
				maxShows,
				websiteUrl: params.calendarUrl.includes("capcitycomedy")
					? "https://www.capcitycomedy.com/"
					: null,
			});
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from SeatEngine (next ${daysAhead} days, max ${maxShows} listings).`,
			);
		} catch (err) {
			messages.push(`SeatEngine parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (eventon) {
		try {
			const events = filterByDaysAhead(
				await fetchEventOnEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
					maxEvents: 40,
				}),
				Math.max(daysAhead, 120),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from EventON calendar (#evcal_list + month chevron AJAX → detail JSON-LD, next ${Math.max(daysAhead, 120)} days).`,
			);
			if (eventsFound === 0) {
				messages.push(
					"EventON markers found but no upcoming events with parseable startDate — check /calendar/ shortcode AJAX or list links.",
				);
			}
		} catch (err) {
			messages.push(`EventON parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (mec) {
		try {
			const events = await fetchMecEvents({
				calendarHtml: html,
				calendarUrl: params.calendarUrl,
				venueName: params.venueName,
				address: params.venueAddress ?? null,
				timezone: "America/Chicago",
				scrapeDaysAhead: daysAhead,
				maxEvents: 10,
			});
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(`Parsed ${eventsFound} events from MEC agenda/month views (next ${daysAhead} days).`);
		} catch (err) {
			messages.push(`MEC parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (prekindle) {
		try {
			const events = filterByDaysAhead(
				await fetchPrekindleEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					enrichPromoPages: true,
					maxEnrich: 15,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from Prekindle (organizer API + promo flyer/RSVP, next ${daysAhead} days).`,
			);
			if (!prekindleOrganizerId) {
				messages.push("Note: data-org-id / organizer id missing — parse may have used URL detection only.");
			}
		} catch (err) {
			messages.push(`Prekindle parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (tec) {
		try {
			const events = filterByDaysAhead(
				await fetchTecEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: daysAhead,
					maxEvents: 30,
					browser: params.browser,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from The Events Calendar (REST or month grid → detail pages, next ${daysAhead} days).`,
			);
		} catch (err) {
			messages.push(`TEC parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (zoogle) {
		try {
			const events = filterByDaysAhead(
				await fetchZoogleEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: daysAhead,
					maxPages: 7,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(`Parsed ${eventsFound} events from Zoogle calendar (pages 1–7, next ${daysAhead} days).`);
		} catch (err) {
			messages.push(`Zoogle parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (livenation) {
		try {
			const events = filterByDaysAhead(
				await fetchLiveNationEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: daysAhead,
					browser: params.browser,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(`Parsed ${eventsFound} events from LiveNation JSON-LD (next ${daysAhead} days).`);
		} catch (err) {
			messages.push(`LiveNation parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (esthers) {
		try {
			const events = filterByDaysAhead(
				await fetchEsthersFolliesEvents({
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: daysAhead,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(`Parsed ${eventsFound} recurring Esther's Follies showtimes (next ${daysAhead} days).`);
		} catch (err) {
			messages.push(`Esther's parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (ace) {
		try {
			const events = filterByDaysAhead(
				await fetchAceCalendarEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: daysAhead,
					browser: params.browser,
					maxProductions: 8,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from ACE Calendar LIST (layout=B) (next ${daysAhead} days).`,
			);
		} catch (err) {
			messages.push(`ACE Calendar parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (spacecrafted) {
		try {
			const events = filterByDaysAhead(
				await fetchSpacecraftedEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 60),
					maxEvents: 40,
					enrichDetails: true,
				}),
				Math.max(daysAhead, 60),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from Spacecrafted calendar API (detail pages, next ${Math.max(daysAhead, 60)} days).`,
			);
		} catch (err) {
			messages.push(
				`Spacecrafted parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (spotapps) {
		try {
			const events = filterByDaysAhead(
				await fetchSpotAppsEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 90),
				}),
				Math.max(daysAhead, 90),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from SpotApps events-holder (event-image / h2 / event-time; free, no ticket URL; next ${Math.max(daysAhead, 90)} days).`,
			);
		} catch (err) {
			messages.push(
				`SpotApps parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (eventsManager) {
		try {
			const events = filterByDaysAhead(
				await fetchEventsManagerEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
					browser: params.browser,
				}),
				Math.max(daysAhead, 120),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			const withImg = events.filter((e) => e.image_url).length;
			messages.push(
				`Parsed ${eventsFound} Events Manager shows across months (?mo=&yr=; event_notes / event_name / flyer; ${withImg} with images; next ${Math.max(daysAhead, 120)} days).`,
			);
		} catch (err) {
			messages.push(
				`Events Manager parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (outhousetickets) {
		try {
			const events = filterByDaysAhead(
				await fetchOuthouseTicketsEvents({
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
				}),
				Math.max(daysAhead, 120),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			const withImg = events.filter((e) => e.image_url).length;
			messages.push(
				`Parsed ${eventsFound} Outhouse Tickets shows (venue grid → ticket URL, Cloudinary flyer, title, date/time; ${withImg} with images; next ${Math.max(daysAhead, 120)} days).`,
			);
		} catch (err) {
			messages.push(
				`Outhouse Tickets parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (squarespaceEvents) {
		try {
			const events = filterByDaysAhead(
				await fetchSquarespaceEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 120),
				}),
				Math.max(daysAhead, 120),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from Squarespace eventlist HTML (eventlist-event cards; JSON fallback if needed; next ${Math.max(daysAhead, 120)} days).`,
			);
		} catch (err) {
			messages.push(
				`Squarespace Events parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (squarespaceUserItems) {
		try {
			const events = filterByDaysAhead(
				await fetchSquarespaceUserItemsEvents({
					calendarHtml: html,
					calendarUrl: params.calendarUrl,
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					timezone: "America/Chicago",
					scrapeDaysAhead: Math.max(daysAhead, 180),
				}),
				Math.max(daysAhead, 180),
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasImages = events.some((e) => Boolean(e.image_url));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(
				`Parsed ${eventsFound} events from Squarespace User Items list (next ${Math.max(daysAhead, 180)} days).`,
			);
		} catch (err) {
			messages.push(
				`Squarespace User Items parse failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else {
	const feedType = toFeedType(detected);
	const discoveredFeedType = discoveredFeed ? detectFeedTypeFromUrl(discoveredFeed) : null;
	if (
		discoveredFeed &&
		(feedType === "ical" ||
			feedType === "google_calendar" ||
			discoveredFeedType === "ical" ||
			discoveredFeedType === "google_calendar")
	) {
		try {
			const ics = await fetchText(discoveredFeed);
			const events = filterByDaysAhead(
				parseIcalFeed(ics, {
					venueName: params.venueName,
					address: params.venueAddress ?? null,
					sourceUrl: discoveredFeed,
					sourcePartner: detected,
				}),
				daysAhead,
			);
			eventsFound = events.length;
			sampleTitles.push(...events.slice(0, 5).map((e) => e.title));
			hasTicketLinks = events.some((e) => Boolean(e.ticket_url));
			messages.push(`Parsed ${eventsFound} events from iCal feed (next ${daysAhead} days).`);
		} catch (err) {
			messages.push(`iCal parse failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		const markdown = await renderMarkdown(params.browser, params.calendarUrl);
		hasImages = /!\[[^\]]*\]\([^)]+\)/.test(markdown);
		hasTicketLinks = Boolean(extractTicketUrlFromMarkdown(markdown));
		// Rough count: non-empty lines that look like dated event blocks.
		const eventish = markdown
			.split(/\n\n+/)
			.filter((block) => /\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|pm|am|\d:\d{2}/i.test(block))
			.filter((block) => block.trim().length > 20);
		eventsFound = eventish.length;
		const titleLine = eventish.slice(0, 5).map((b) => b.split("\n").find((l) => l.trim().length > 3)?.trim() ?? "");
		sampleTitles.push(...titleLine.filter(Boolean));
		messages.push(
			eventsFound > 0
				? `Found ~${eventsFound} event-like blocks in rendered page (next step: wire a ${platformLabel(detected)} parser).`
				: "No event blocks detected in rendered page — may need a custom adapter.",
		);
		if (hasTicketLinks) messages.push("Ticket vendor links detected.");
		if (hasImages) messages.push("Images detected on calendar page.");
	}
	}

	const structuredPlatforms: PlatformType[] = [
		"event_discovery",
		"prekindle",
		"webflow",
		"seatengine",
		"eventon",
		"mec",
		"tec",
		"zoogle",
		"livenation",
		"esthers_follies",
		"ace_calendar",
		"spacecrafted",
		"spotapps",
		"events_manager",
		"outhousetickets",
		"squarespace_events",
		"squarespace_user_items",
		"heyaustin",
		"cota",
		"germania_amp",
		"vulcan_atx",
		"comedy_mothership",
		"docs_drive_in",
		"white_horse",
		"ical",
		"google_calendar",
	];
	const ready =
		eventsFound > 0 &&
		(structuredPlatforms.includes(resolvedPlatform) ||
			(toFeedType(resolvedPlatform) === "ical" && Boolean(discoveredFeed)));

	return {
		calendar_url: params.calendarUrl,
		detected_platform: resolvedPlatform,
		platform_label: platformLabel(resolvedPlatform),
		feed_url: discoveredFeed,
		events_found: eventsFound,
		has_ticket_links: hasTicketLinks,
		has_images: hasImages,
		ready,
		messages,
		sample_titles: sampleTitles,
	};
}