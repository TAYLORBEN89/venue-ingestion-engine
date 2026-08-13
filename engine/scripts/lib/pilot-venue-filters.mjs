/**
 * Shared rules: only venues that have never been through the pilot pipeline.
 */
import { sortPilotSources } from "./pilot-source-priority.mjs";

/** Venues fully piloted — never re-queue via pilot scripts. */
export const PILOT_COMPLETED_SLUGS = new Set([
	"the-moody-center",
	"moody-center-atx",
	"meanwhile-brewing-company",
	"the-velveeta-room",
	"cap-city-comedy-club",
	"stubbs-bar-b-q",
	"stubb-s-bbq",
	"stubb-s-austin",
	"the-mohawk",
	"moody-amphitheater-austin",
	"hotel-vegas",
	"antones-nightclub",
	"buck-s-backyard",
	"flamingo-cantina",
	"the-carousel-lounge",
	// Dead-end for events (no viable show calendar) — pilot closed 2026-07-14
	"austin-charter-bus-company",
	"austin-eats-food-tours",
	// Not event-calendar venues (rentals / tours / pizza) — skip pilots 2026-07-14
	"aviator-pizza-and-drafthouse",
	"barton-springs-bike-rental",
	"bike-and-brew-atx",
	"capital-cruises",
	"good-time-tours-boat-rentals",
	"lake-travis-yacht-rentals",
	"loro-asian-smokehouse-and-bbq-on-south-lamar",
	"lucille-patio-lounge",
	// No events calendar — skip pilot 2026-07-14
	"whisler-s-austin",
	"yummi-joy",
	"wanderlust-wine-company",
	"tribe-bus-tours",
	"the-tavern",
	"the-parlor-room",
]);

/** Slug substrings that indicate duplicate venue records for an already-piloted brand. */
const DUPLICATE_SLUG_MARKERS = [
	/^stubb/i,
	/^moody-center/i,
	/^moody-amphitheater/i,
];

export function isCompletedPilotSlug(slug) {
	if (PILOT_COMPLETED_SLUGS.has(slug)) return true;
	return DUPLICATE_SLUG_MARKERS.some((re) => re.test(slug));
}

/**
 * True when venue has no published events and no prior approved ingestion.
 * Pending rows from the current pilot run are allowed.
 */
export async function isUnpublishedPilotVenue(supabase, venueId, slug) {
	if (isCompletedPilotSlug(slug)) return false;

	const [{ count: eventCount }, { count: approvedIngested }] = await Promise.all([
		supabase.from("events").select("id", { count: "exact", head: true }).eq("venue_id", venueId),
		supabase
			.from("ingested_events")
			.select("id", { count: "exact", head: true })
			.eq("venue_id", venueId)
			.eq("review_status", "approved"),
	]);

	return (eventCount ?? 0) === 0 && (approvedIngested ?? 0) === 0;
}

/** Skip when another venue already published events from the same calendar URL. */
export async function calendarUrlAlreadyPiloted(supabase, calendarUrl, siteId, selfVenueId) {
	if (!calendarUrl) return false;
	const normalized = calendarUrl.split("?")[0].replace(/\/$/, "").toLowerCase();

	const { data: siblings } = await supabase
		.from("venues")
		.select("id, slug, calendar_url")
		.eq("site_id", siteId)
		.neq("id", selfVenueId)
		.not("calendar_url", "is", null);

	for (const row of siblings ?? []) {
		const other = (row.calendar_url ?? "").split("?")[0].replace(/\/$/, "").toLowerCase();
		if (other !== normalized) continue;
		const { count } = await supabase
			.from("events")
			.select("id", { count: "exact", head: true })
			.eq("venue_id", row.id);
		if ((count ?? 0) > 0) return true;
	}
	return false;
}

export async function loadNewPilotSources(supabase, siteId) {
	const { data: sources, error } = await supabase
		.from("venue_event_sources")
		.select(
			"id, feed_url, platform_type, venues(id, slug, name, calendar_url, address, event_feed_url, event_feed_type)",
		)
		.eq("is_enabled", true);

	if (error) throw error;

	const fresh = [];
	for (const source of sources ?? []) {
		const venue = source.venues;
		if (!venue?.calendar_url && !venue?.event_feed_url && !source.feed_url) continue;
		if (!(await isUnpublishedPilotVenue(supabase, venue.id, venue.slug))) continue;
		if (await calendarUrlAlreadyPiloted(supabase, venue.calendar_url ?? source.feed_url, siteId, venue.id)) {
			continue;
		}
		fresh.push({ ...source, venues: venue });
	}

	return sortPilotSources(fresh);
}