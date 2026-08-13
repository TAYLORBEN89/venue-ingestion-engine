/**
 * Regression: venue title must never be replaced by catalog artist name.
 * Self-contained (no TS imports) so it runs under plain node.
 */

function eventFingerprint(title, venue, starts, ticket) {
	return [title, venue, starts, ticket ?? ""].join("|");
}

function enrichFromArtistCatalog(event, match) {
	const venueTitle = event.title;
	const artist = match.matched_artist;
	const sources = {
		title: "venue",
		description: event.description ? "venue" : "none",
		ticket_url: event.ticket_url ? "venue" : "none",
		price_text: event.price_text ? "venue" : "none",
		starts_at: "venue",
		image: event.image_url ? "venue" : "none",
		youtube: "none",
	};
	if (match.artist_match_status !== "matched" || !artist) {
		return { ...event, title: venueTitle, original_title: venueTitle, field_sources: sources };
	}
	const youtubeId = event.youtube_id ?? artist.youtube_id ?? null;
	const artistMediaId = !event.image_url ? artist.featured_media_id : null;
	return {
		...event,
		title: venueTitle,
		original_title: venueTitle,
		matched_artist_id: match.matched_artist_id,
		extracted_band_name: match.extracted_band_name,
		artist_match_confidence: Math.round(match.match_score * 100),
		youtube_id: youtubeId,
		artist_media_id: artistMediaId,
		seo_title: artist.seo_title,
		fingerprint: eventFingerprint(venueTitle, event.venue_name, event.starts_at, event.ticket_url),
		field_sources: {
			...sources,
			title: "venue",
			youtube: event.youtube_id ? "venue" : youtubeId ? "artist" : "none",
			image: event.image_url ? "venue" : artistMediaId ? "artist" : "none",
			seo_title: artist.seo_title ? "artist" : "none",
		},
	};
}

const venueTitle = "An Evening with Christine Albert & Special Guests";
const event = {
	title: venueTitle,
	starts_at: "2026-08-01T02:00:00.000Z",
	venue_name: "The Saxon Pub",
	ticket_url: "https://example.com/tix",
	price_text: "$20",
	description: "Doors at 7",
	image_url: "https://example.com/poster.jpg",
	youtube_id: null,
};
const match = {
	extracted_band_name: "Christine Albert",
	matched_artist_id: "artist-uuid",
	artist_match_status: "matched",
	match_score: 0.99,
	matched_artist: {
		name: "Christine Albert",
		youtube_id: "dQw4w9WgXcQ",
		featured_media_id: "media-uuid",
		seo_title: "Christine Albert | Austin",
	},
};

const out = enrichFromArtistCatalog(event, match);
const fails = [];
if (out.title !== venueTitle) fails.push(`title rewritten to ${out.title}`);
if (out.field_sources?.title !== "venue") fails.push("title source");
if (out.youtube_id !== "dQw4w9WgXcQ") fails.push("youtube");
if (out.image_url !== event.image_url) fails.push("image");
if (out.ticket_url !== event.ticket_url) fails.push("ticket");
if (fails.length) {
	console.error("FAIL", fails);
	process.exit(1);
}
console.log("OK enrich title policy");
console.log(" ", out.title);
console.log(" ", out.field_sources);
