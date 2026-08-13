import { resolveEvergreenArtistSeo } from "./artist-seo";
import { generateEventIntro } from "./event-intro";
import { resolveEventDescription } from "./venue-description-fallback";
import { generateEventSeo } from "./event-seo";
import type { PartnerEvent } from "./normalize";
import { eventFingerprint } from "./fingerprint";
import type { ArtistMatchResult, MatchedLineupArtist } from "./match-artist";

/** Provenance for admin + re-fetch policies. */
export type FieldSource = "venue" | "artist" | "manual" | "generated" | "none";

export type FieldSources = Partial<{
	title: FieldSource;
	description: FieldSource;
	event_intro: FieldSource;
	image: FieldSource;
	youtube: FieldSource;
	genres: FieldSource;
	seo_title: FieldSource;
	seo_description: FieldSource;
	focus_keyphrase: FieldSource;
	ticket_url: FieldSource;
	price_text: FieldSource;
	starts_at: FieldSource;
	ends_at: FieldSource;
}>;

export interface EnrichedPartnerEvent extends PartnerEvent {
	extracted_band_name: string;
	matched_artist_id: string | null;
	artist_match_status: "matched" | "unmatched" | "ambiguous";
	artist_match_score: number;
	/** Venue calendar title — never replaced by catalog name. */
	original_title: string;
	artist_media_id: string | null;
	youtube_embed: string | null;
	youtube_id: string | null;
	genres: string[];
	seo_title: string | null;
	seo_description: string | null;
	focus_keyphrase: string | null;
	event_intro: string | null;
	field_sources: FieldSources;
	/** Display confidence 0–100 for admin */
	artist_match_confidence: number;
	artist_content_source: "none" | "catalog";
	/** Multi-artist lineup after match (may be empty). */
	matched_lineup: MatchedLineupArtist[];
}

function buildEventIntro(
	artistName: string,
	genres: string[],
	event: PartnerEvent,
	venueDescription: string | null | undefined,
	siteCity: string | null | undefined,
	venueCategorySlugs?: string[],
): string {
	return generateEventIntro({
		artistName,
		venueName: event.venue_name,
		venueDescription,
		venueCategorySlugs,
		eventTitle: event.title,
		genres,
		startsAt: event.starts_at,
		city: siteCity,
	});
}

function venueFieldSources(event: PartnerEvent): FieldSources {
	return {
		title: "venue",
		description: event.description ? "venue" : "none",
		ticket_url: event.ticket_url ? "venue" : "none",
		price_text: event.price_text ? "venue" : "none",
		starts_at: "venue",
		ends_at: event.ends_at ? "venue" : "none",
		image: event.image_url ? "venue" : "none",
		youtube: event.youtube_id || event.youtube_embed ? "venue" : "none",
		event_intro: "none",
		genres: "none",
		seo_title: "none",
		seo_description: "none",
		focus_keyphrase: "none",
	};
}

/**
 * POLICY (ingest SEO — always on):
 * Every staged event gets template event SEO (title | venue city | brand)
 * plus a generated event_intro. Artist catalog still supplies YT/genres/media
 * when matched; artist evergreen SEO is optional enrichment only if event SEO
 * somehow missing (should not happen).
 *
 * Public event title ALWAYS remains the venue-fetched title.
 */
export function enrichFromArtistCatalog(
	event: PartnerEvent,
	match: ArtistMatchResult,
	siteCity?: string | null,
	venueDescription?: string | null,
	lineup: MatchedLineupArtist[] = [],
	siteBrand?: string | null,
	/** Venue category slugs — tailor generated intro to the room type */
	venueCategorySlugs?: string[],
	/** venues.slug — for per-venue description fallbacks when scrape has no body */
	venueSlug?: string | null,
): EnrichedPartnerEvent {
	const artist = match.matched_artist;
	const venueTitle = event.title;
	const sources = venueFieldSources(event);
	const confidencePct = Math.round(Math.min(1, Math.max(0, match.match_score)) * 100);

	const city = siteCity?.trim() || "Austin";
	const brand = siteBrand?.trim() || "HeyAustin";
	const displayName =
		match.extracted_band_name?.trim() ||
		artist?.name?.trim() ||
		venueTitle.trim() ||
		"Live Event";

	// Always generate per-event SEO on ingest (venue-kind aware — comedy ≠ live music)
	const eventSeo = generateEventSeo({
		title: venueTitle,
		venueName: event.venue_name,
		city,
		brandName: brand,
		startsAt: event.starts_at,
		priceText: event.price_text,
		venueDescription,
		venueCategorySlugs,
		genres: artist?.genres ?? [],
	});

	// Always generate intro tailored to this venue (categories + description + kind)
	const eventIntro = buildEventIntro(
		displayName,
		artist?.genres ?? [],
		event,
		venueDescription,
		city,
		venueCategorySlugs,
	);

	// Partner body when present; else only venues with a trained fallback template
	const resolvedDesc = resolveEventDescription({
		scrapedDescription: event.description,
		artistName: displayName,
		venueName: event.venue_name,
		venueSlug,
		startsAt: event.starts_at,
		eventTitle: venueTitle,
	});
	const description = resolvedDesc.description;
	const descriptionSource: FieldSource = resolvedDesc.source;

	const base: EnrichedPartnerEvent = {
		...event,
		title: venueTitle,
		description,
		extracted_band_name: match.extracted_band_name,
		matched_artist_id: match.matched_artist_id,
		artist_match_status: match.artist_match_status,
		artist_match_score: match.match_score,
		artist_match_confidence: confidencePct,
		original_title: venueTitle,
		artist_media_id: null,
		youtube_embed: event.youtube_embed ?? null,
		youtube_id: event.youtube_id ?? null,
		genres: [],
		seo_title: eventSeo.seo_title,
		seo_description: eventSeo.seo_description,
		focus_keyphrase: eventSeo.focus_keyphrase,
		event_intro: eventIntro,
		field_sources: {
			...sources,
			description: descriptionSource,
			event_intro: "generated",
			seo_title: "generated",
			seo_description: "generated",
			focus_keyphrase: "generated",
		},
		artist_content_source: "none",
		matched_lineup: lineup,
		fingerprint: eventFingerprint(venueTitle, event.venue_name, event.starts_at, event.ticket_url),
	};

	if (match.artist_match_status !== "matched" || !artist) {
		return base;
	}

	// Matched artist: keep event SEO (per-show); enrich media/genres/intro from catalog
	const youtubeEmbed = event.youtube_embed ?? artist.youtube_embed ?? null;
	const youtubeId = event.youtube_id ?? artist.youtube_id ?? null;
	const youtubeSource: FieldSource =
		event.youtube_id || event.youtube_embed
			? "venue"
			: youtubeId || youtubeEmbed
				? "artist"
				: "none";

	const artistMediaId = !event.image_url ? (artist.featured_media_id ?? null) : null;
	const imageSource: FieldSource = event.image_url ? "venue" : artistMediaId ? "artist" : "none";

	// Prefer catalog artist SEO only when event SEO would be empty (never after always-on)
	const artistSeo = resolveEvergreenArtistSeo(artist, city);

	return {
		...base,
		title: venueTitle,
		original_title: venueTitle,
		// Keep generic fill from base when partner had no description
		description,
		image_url: event.image_url,
		artist_media_id: artistMediaId,
		youtube_embed: youtubeEmbed,
		youtube_id: youtubeId,
		genres: artist.genres ?? [],
		// Event-level SEO stays primary for event pages
		seo_title: eventSeo.seo_title || artistSeo.seo_title,
		seo_description: eventSeo.seo_description || artistSeo.seo_description,
		focus_keyphrase: eventSeo.focus_keyphrase || artistSeo.focus_keyphrase,
		event_intro: buildEventIntro(
			artist.name,
			artist.genres ?? [],
			event,
			venueDescription,
			city,
			venueCategorySlugs,
		),
		artist_content_source: "catalog",
		field_sources: {
			...sources,
			title: "venue",
			description: descriptionSource,
			image: imageSource,
			youtube: youtubeSource,
			genres: (artist.genres?.length ?? 0) > 0 ? "artist" : "none",
			seo_title: "generated",
			seo_description: "generated",
			focus_keyphrase: "generated",
			event_intro: "generated",
			ticket_url: event.ticket_url ? "venue" : "none",
			price_text: event.price_text ? "venue" : "none",
			starts_at: "venue",
			ends_at: event.ends_at ? "venue" : "none",
		},
		fingerprint: eventFingerprint(venueTitle, event.venue_name, event.starts_at, event.ticket_url),
	};
}
