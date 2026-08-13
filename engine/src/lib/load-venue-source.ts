import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedType } from "./normalize";
import type { PlatformType } from "./sources/detect-platform";
import { toFeedType } from "./sources/detect-platform";

export interface VenueEventSourceRow {
	id: string;
	venue_id: string;
	calendar_url: string;
	feed_url: string | null;
	platform_type: PlatformType;
	scrape_days_ahead: number;
	publish_mode: "draft" | "auto_publish";
	timezone: string | null;
}

export interface ResolvedVenueSource {
	sourceId: string | null;
	calendar_url: string;
	event_feed_url: string | null;
	event_feed_type: FeedType;
	platform_type: PlatformType;
	scrape_days_ahead: number;
	publish_mode: "draft" | "auto_publish";
	timezone_override: string | null;
}

export async function loadVenueSource(
	supabase: SupabaseClient,
	venueId: string,
	sourceId?: string,
): Promise<ResolvedVenueSource> {
	if (sourceId) {
		const { data, error } = await supabase
			.from("venue_event_sources")
			.select("id, calendar_url, feed_url, platform_type, scrape_days_ahead, publish_mode, timezone")
			.eq("id", sourceId)
			.eq("venue_id", venueId)
			.single<VenueEventSourceRow>();
		if (error || !data) throw new Error(`Source ${sourceId} not found for venue ${venueId}`);
		return {
			sourceId: data.id,
			calendar_url: data.calendar_url,
			event_feed_url: data.feed_url,
			event_feed_type: toFeedType(data.platform_type),
			platform_type: data.platform_type,
			scrape_days_ahead: data.scrape_days_ahead,
			publish_mode: data.publish_mode,
			timezone_override: data.timezone,
		};
	}

	const { data: sources, error: sourcesError } = await supabase
		.from("venue_event_sources")
		.select("id, calendar_url, feed_url, platform_type, scrape_days_ahead, publish_mode, timezone")
		.eq("venue_id", venueId)
		.eq("is_enabled", true)
		.order("created_at", { ascending: true })
		.limit(1);

	if (sourcesError) throw new Error(`Failed to load venue sources: ${sourcesError.message}`);

	const source = (sources?.[0] as VenueEventSourceRow | undefined) ?? null;
	if (source) {
		return {
			sourceId: source.id,
			calendar_url: source.calendar_url,
			event_feed_url: source.feed_url,
			event_feed_type: toFeedType(source.platform_type),
			platform_type: source.platform_type,
			scrape_days_ahead: source.scrape_days_ahead,
			publish_mode: source.publish_mode,
			timezone_override: source.timezone,
		};
	}

	// Legacy fallback: venues.calendar_url / event_feed_url columns.
	const { data: venue, error: venueError } = await supabase
		.from("venues")
		.select("calendar_url, event_feed_url, event_feed_type")
		.eq("id", venueId)
		.single();

	if (venueError || !venue) throw new Error(`Venue ${venueId} not found`);
	if (!venue.calendar_url && !venue.event_feed_url) {
		throw new Error(`Venue ${venueId} has no event source configured`);
	}

	return {
		sourceId: null,
		calendar_url: venue.calendar_url ?? venue.event_feed_url,
		event_feed_url: venue.event_feed_url,
		event_feed_type: (venue.event_feed_type as FeedType | null) ?? "auto",
		platform_type: "auto",
		scrape_days_ahead: 90,
		publish_mode: "draft",
		timezone_override: null,
	};
}