export type PlatformType =
	| "auto"
	| "ical"
	| "google_calendar"
	| "tec"
	| "eventon"
	| "mec"
	| "eventbrite"
	| "bandsintown"
	| "axs"
	| "prekindle"
	| "event_discovery"
	| "webflow"
	| "seatengine"
	| "zoogle"
	| "livenation"
	| "esthers_follies"
	| "squarespace_user_items"
	| "squarespace_events"
	| "ace_calendar"
	| "spacecrafted"
	| "spotapps"
	| "events_manager"
	| "outhousetickets"
	| "heyaustin"
	| "laketravis"
	| "germania_amp"
	| "cota"
	| "vulcan_atx"
	| "comedy_mothership"
	| "docs_drive_in"
	| "white_horse"
	| "wordpress"
	| "custom_html"
	| "scrape";

const PLATFORM_LABELS: Record<PlatformType, string> = {
	auto: "Auto-detect",
	ical: "iCal / ICS feed",
	google_calendar: "Google Calendar",
	tec: "The Events Calendar (WordPress)",
	eventon: "EventON (WordPress)",
	mec: "Modern Events Calendar",
	eventbrite: "Eventbrite",
	bandsintown: "Bandsintown",
	axs: "AXS",
	prekindle: "Prekindle",
	event_discovery: "Event Discovery (WordPress)",
	webflow: "Webflow events",
	seatengine: "SeatEngine calendar",
	zoogle: "Zoogle calendar",
	livenation: "LiveNation / Ticketmaster venue",
	esthers_follies: "Esther's Follies (recurring revue)",
	squarespace_user_items: "Squarespace User Items List",
	squarespace_events: "Squarespace Events collection",
	ace_calendar: "ACE Calendar (LIST layout=B)",
	spacecrafted: "Spacecrafted events",
	spotapps: "SpotApps events (listing or pinboard/agenda)",
	events_manager: "Events Manager (WordPress calendar)",
	outhousetickets: "Outhouse Tickets (venue grid)",
	heyaustin: "HeyAustin (Listar events)",
	laketravis: "Lake Travis (Listar places/events)",
	germania_amp: "Germania Insurance Amphitheater (germaniaamp.com)",
	cota: "Circuit of The Americas (events list)",
	vulcan_atx: "Vulcan Gas Company (vulcanatx.com Webflow list)",
	comedy_mothership: "Comedy Mothership (/shows grid)",
	docs_drive_in: "Doc's Drive-In (FullCalendar + /api/events)",
	white_horse: "The White Horse (Events Calendar / Google sync)",
	wordpress: "WordPress (generic)",
	custom_html: "Custom HTML",
	scrape: "General page scrape",
};

export function platformLabel(type: PlatformType): string {
	return PLATFORM_LABELS[type] ?? type;
}

/** Inspect page HTML and URL to guess the calendar platform. */
export function detectPlatformFromHtml(html: string, pageUrl: string): PlatformType {
	const haystack = `${pageUrl}\n${html}`.toLowerCase();

	if (/\.ics(\?|$)|webcal:|text\/calendar/i.test(haystack)) return "ical";
	if (/google\.com\/calendar/i.test(haystack)) return "google_calendar";
	if (/eventbrite\.com|eventbrite-widget/i.test(haystack)) return "eventbrite";
	if (/bandsintown\.com|bandsintown-widget/i.test(haystack)) return "bandsintown";
	if (/axs\.com|axs\.com\/events/i.test(haystack)) return "axs";
	// HeyAustin listings include FB event plugin CSS that can look like other WP event plugins.
	if (/heyaustin\.com/i.test(pageUrl)) return "heyaustin";
	// Lake Travis Listar (venues/events) — brand origin, not HeyAustin
	if (/laketravis\.com/i.test(pageUrl)) return "laketravis";
	// COTA before zoogle/ticketmaster noise on the same page
	if (/circuitoftheamericas\.com/i.test(pageUrl)) return "cota";
	if (/germaniaamp\.com/i.test(pageUrl)) return "germania_amp";
	if (/vulcanatx\.com/i.test(pageUrl)) return "vulcan_atx";
	if (/comedymothership\.com/i.test(pageUrl)) return "comedy_mothership";
	if (/docsdriveintheatre\.com/i.test(pageUrl)) return "docs_drive_in";
	if (/thewhitehorseaustin\.com/i.test(pageUrl)) return "white_horse";
	if (/event-discovery|get_events_for_calendar|wp-content\/plugins\/event-discovery/i.test(haystack)) {
		return "event_discovery";
	}
	// Cap City Comedy + SeatEngine: se-calendar grid and/or seatengine CDN
	if (
		/cdn\.seatengine\.com|seatengine\.com\/calendar|files\.seatengine\.com/i.test(haystack) ||
		/id=["']se-calendar["']/i.test(html) ||
		/capcitycomedy\.com/i.test(pageUrl)
	) {
		return "seatengine";
	}
	if (/esthersfollies\.com/i.test(pageUrl)) return "esthers_follies";
	if (
		/ace-calendar\.js|ace-api\/events|ace-cal-list-|calendarKeyword/i.test(haystack) ||
		/zachtheater\.org\/calendar|zachtheatre\.org/i.test(pageUrl)
	) {
		return "ace_calendar";
	}
	// Native Squarespace Events collection (Frontyard etc.) before user-items list.
	if (
		/frontyardbrewing\.com/i.test(pageUrl) ||
		(/eventlist-event/i.test(html) &&
			/squarespace|static\.sqspcdn|static1\.squarespace/i.test(haystack)) ||
		(/squarespace|static\.sqspcdn/i.test(haystack) &&
			/eventlist-title/i.test(html) &&
			/upcoming-events|\/events(?:-\d+)?(?:\/|$|\?)/i.test(pageUrl))
	) {
		return "squarespace_events";
	}
	if (
		/user-items-list/i.test(haystack) &&
		/list-item-content__(?:title|button)/i.test(haystack)
	) {
		return "squarespace_user_items";
	}
	if (/29thstreetballroom\.com/i.test(pageUrl)) return "squarespace_user_items";
	if (
		/zoogletools\.com|data-occurrence-id|calendar_feature_/i.test(haystack) ||
		/elephantroom\.com\/calendar/i.test(pageUrl)
	) {
		return "zoogle";
	}
	// COTA / Germania markup when URL is not already matched above
	if (
		/event-column d-flex/i.test(html) &&
		/event-tag/i.test(html) &&
		/event-date/i.test(html) &&
		/circuitoftheamericas/i.test(html)
	) {
		return "cota";
	}
	if (/upcoming-shows/i.test(html) && /card events/i.test(html) && /media-left/i.test(html)) {
		return "germania_amp";
	}
	if (
		/livenation|livenationcdn|ticketmaster\.com/i.test(haystack) ||
		/scootinnaustin\.com|emosaustin\.com/i.test(pageUrl)
	) {
		return "livenation";
	}
	if (/website-files\.com|webflow/i.test(haystack) && /\/events\//i.test(haystack)) return "webflow";
	if (
		/spacecrafted\.com|eventColl-item|itemsCollectionContent/i.test(haystack) ||
		/jesterkingbrewery\.com/i.test(pageUrl)
	) {
		return "spacecrafted";
	}
	// SpotApps / SpotHopper (Moontower listing + Doc's pinboard/agenda)
	if (
		/moontowersaloon\.com|eatdrinkdocs\.com/i.test(pageUrl) ||
		(/event-calendar-card/i.test(html) &&
			/pinboardAgendaContainer|data-event-start-date|events-pinboard-view/i.test(html)) ||
		(/static\.spotapps\.co/i.test(haystack) &&
			/event-image|events-holder|atc_date_start|event-calendar-card/i.test(html)) ||
		(/events-holder/i.test(html) && /event-time/i.test(html) && /atc_date_start/i.test(html))
	) {
		return "spotapps";
	}
	// WordPress Events Manager (Hideout Theatre calendar)
	if (
		/hideouttheatre\.com/i.test(pageUrl) ||
		/em-cal-body|em-cal-days|event_notes|events-manager\/v1/i.test(haystack) ||
		(/event_name/i.test(html) && /event_date/i.test(html) && /event_id=/i.test(html))
	) {
		return "events_manager";
	}
	// Outhouse Tickets SPA venue grids (Poodie's Hilltop Roadhouse et al.)
	if (/outhousetickets\.com/i.test(pageUrl) || /outhousetickets\.com/i.test(haystack)) {
		return "outhousetickets";
	}
	if (/\/all-events\/|modern-events-calendar|mec-calendar|cat_ids~/i.test(haystack)) return "mec";
	if (
		/prekindle\.com\/api\/events\/organizer\/|pk-cal-widget|pk-cal-loader|data-org-id/i.test(
			haystack,
		) ||
		/theholeinthewallaustin\.com/i.test(pageUrl)
	) {
		return "prekindle";
	}
	// URL-only TEC hints (WAF captcha pages have no tribe-* classes in HTML)
	if (
		/tribe-events|the-events-calendar|tec-events|tribe_events|\/events\/month\//i.test(haystack) ||
		/thesaxonpub\.com\/events/i.test(pageUrl)
	) {
		return "tec";
	}
	if (
		/eventon|eventon_events|ajde_events|ajde_evcal|evcal_/i.test(haystack) ||
		/speakeasyaustin\.com/i.test(pageUrl)
	) {
		return "eventon";
	}
	if (/modern-events-calendar|mec-events|mec_event/i.test(haystack)) return "mec";
	if (/wp-content|wordpress|wp-json/i.test(haystack)) return "wordpress";

	return "custom_html";
}

export function toFeedType(platform: PlatformType): "ical" | "google_calendar" | "scrape" | "auto" {
	if (platform === "ical") return "ical";
	if (platform === "google_calendar") return "google_calendar";
	if (platform === "auto") return "auto";
	return "scrape";
}