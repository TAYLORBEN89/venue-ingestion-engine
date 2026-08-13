/**
 * Re-run band extraction + catalog matching + enrichment on pending ingested_events.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { extractBandName, normalizeBandNameForMatch } from "../src/lib/parse-band-name.ts";
import { resolveEvergreenArtistSeo } from "../src/lib/artist-seo.ts";
import { generateEventIntro } from "../src/lib/event-intro.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devVars = readFileSync(resolve(__dirname, "../.dev.vars"), "utf8");
const env = Object.fromEntries(
	devVars
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const MATCH_THRESHOLD = 0.92;
const AMBIGUOUS_THRESHOLD = 0.8;

function levenshteinRatio(a, b) {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dist = Array.from({ length: rows }, () => new Array(cols).fill(0));
	for (let i = 0; i < rows; i++) dist[i][0] = i;
	for (let j = 0; j < cols; j++) dist[0][j] = j;
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
		}
	}
	return 1 - dist[rows - 1][cols - 1] / Math.max(a.length, b.length);
}

function matchBandToCatalog(rawTitle, catalog) {
	const extracted = extractBandName(rawTitle);
	const target = normalizeBandNameForMatch(extracted);
	let best = null;
	let secondBest = 0;

	for (const artist of catalog) {
		const names = [artist.name, ...(artist.aliases ?? [])].map(normalizeBandNameForMatch).filter(Boolean);
		let score = 0;
		for (const name of names) {
			score = Math.max(score, levenshteinRatio(target, name));
			if (target === name) score = 1;
		}
		if (!best || score > best.score) {
			secondBest = best?.score ?? 0;
			best = { artist, score };
		} else if (score > secondBest) {
			secondBest = score;
		}
	}

	if (!best || best.score < AMBIGUOUS_THRESHOLD) {
		return {
			extracted_band_name: extracted,
			matched_artist_id: null,
			artist_match_status: "unmatched",
			artist_match_score: best?.score ?? 0,
			matched_artist: null,
		};
	}

	const ambiguous = secondBest >= AMBIGUOUS_THRESHOLD && best.score - secondBest < 0.05;
	const status = ambiguous || best.score < MATCH_THRESHOLD ? "ambiguous" : "matched";
	return {
		extracted_band_name: extracted,
		matched_artist_id: best.artist.id,
		artist_match_status: status,
		artist_match_score: best.score,
		matched_artist: best.artist,
	};
}

function enrich(row, match, originalTitle) {
	const artist = match.matched_artist;
	const city = row.venues?.sites?.city ?? null;
	const venueName = row.venues?.name ?? "";
	const startsAt = row.parsed_starts_at ?? "";

	const eventIntro = generateEventIntro({
		artistName: match.extracted_band_name || originalTitle,
		venueName,
		genres: artist?.genres ?? [],
		startsAt,
		city,
	});

	const base = {
		title: originalTitle,
		extracted_band_name: match.extracted_band_name,
		matched_artist_id: match.matched_artist_id,
		artist_match_status: match.artist_match_status,
		artist_match_score: match.artist_match_score,
		original_title: originalTitle,
		artist_media_id: artist?.featured_media_id ?? null,
		youtube_embed: artist?.youtube_embed ?? null,
		youtube_id: artist?.youtube_id ?? null,
		genres: artist?.genres ?? [],
		seo_title: null,
		seo_description: null,
		focus_keyphrase: null,
		event_intro: eventIntro,
		description: null,
	};

	if (match.artist_match_status !== "matched" || !artist) return base;

	const seo = resolveEvergreenArtistSeo(artist, city);
	return {
		...base,
		title: artist.name,
		seo_title: seo.seo_title,
		seo_description: seo.seo_description,
		focus_keyphrase: seo.focus_keyphrase,
		event_intro: generateEventIntro({
			artistName: artist.name,
			venueName,
			genres: artist.genres ?? [],
			startsAt,
			city,
		}),
	};
}

const { data: pending, error } = await supabase
	.from("ingested_events")
	.select(
		"id, raw_title, raw_date_text, parsed_starts_at, parsed_ends_at, source_url, raw_payload, venue_id, venues(name, site_id, sites(city))",
	)
	.eq("review_status", "pending");

if (error) throw error;
if (!pending?.length) {
	console.log("No pending events to rematch.");
	process.exit(0);
}

const siteId = pending[0].venues?.site_id;
// Paginate past Supabase 1000-row default (catalog is 1300+ published artists).
const artists = [];
{
	const pageSize = 1000;
	let from = 0;
	for (;;) {
		const { data, error: artistError } = await supabase
			.from("artists")
			.select(
				"id, name, aliases, genres, bio, featured_media_id, social_links, youtube_embed, youtube_id, seo_title, seo_description, focus_keyphrase",
			)
			.eq("site_id", siteId)
			.eq("status", "published")
			.is("deleted_at", null)
			.order("id")
			.range(from, from + pageSize - 1);
		if (artistError) throw artistError;
		if (!data?.length) break;
		artists.push(...data);
		if (data.length < pageSize) break;
		from += pageSize;
	}
}
console.log("Artist catalog loaded:", artists.length);

let matched = 0;
let ambiguous = 0;
let unmatched = 0;
let updated = 0;

for (const row of pending) {
	const originalTitle = row.raw_payload?.original_title ?? row.raw_title;
	const match = matchBandToCatalog(originalTitle, artists ?? []);
	const enriched = enrich(row, match, originalTitle);

	if (enriched.artist_match_status === "matched") matched++;
	else if (enriched.artist_match_status === "ambiguous") ambiguous++;
	else unmatched++;

	const { error: updateError } = await supabase
		.from("ingested_events")
		.update({
			raw_title: enriched.title,
			extracted_band_name: enriched.extracted_band_name,
			matched_artist_id: enriched.matched_artist_id,
			artist_match_status: enriched.artist_match_status,
			raw_payload: {
				...(row.raw_payload ?? {}),
				description: enriched.description,
				artist_match_score: enriched.artist_match_score,
				original_title: enriched.original_title,
				artist_media_id: enriched.artist_media_id,
				youtube_embed: enriched.youtube_embed,
				youtube_id: enriched.youtube_id,
				genres: enriched.genres,
				seo_title: enriched.seo_title,
				seo_description: enriched.seo_description,
				focus_keyphrase: enriched.focus_keyphrase,
				event_intro: enriched.event_intro,
			},
		})
		.eq("id", row.id);

	if (updateError) {
		console.error(`Failed ${row.id}:`, updateError.message);
		continue;
	}
	updated++;
}

console.log(`Rematched ${updated}/${pending.length} pending events.`);
console.log(`  matched: ${matched} | ambiguous: ${ambiguous} | unmatched: ${unmatched}\n`);

const { data: sample } = await supabase
	.from("ingested_events")
	.select("raw_title, extracted_band_name, artist_match_status")
	.eq("review_status", "pending")
	.order("parsed_starts_at")
	.limit(12);

for (const row of sample ?? []) {
	console.log(`• ${row.extracted_band_name} → ${row.artist_match_status} (${row.raw_title})`);
}