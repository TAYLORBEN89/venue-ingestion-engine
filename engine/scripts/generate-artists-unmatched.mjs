/**
 * Call ingestion worker /generate-artist for all pending unmatched ingested_events.
 * Usage: node scripts/generate-artists-unmatched.mjs [--dry-run]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { extractBandName } from "../src/lib/parse-band-name.ts";

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
const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";
const dryRun = process.argv.includes("--dry-run");

const { data: pending, error } = await supabase
	.from("ingested_events")
	.select(
		"id, raw_title, extracted_band_name, raw_payload, venue:venues(id, site_id, slug, sites(city))",
	)
	.eq("review_status", "pending")
	.eq("artist_match_status", "unmatched");

if (error) throw error;
if (!pending?.length) {
	console.log("No unmatched pending events.");
	process.exit(0);
}

const seen = new Set();
let created = 0;
let linked = 0;
let failed = 0;

for (const row of pending) {
	const bandName = row.extracted_band_name?.trim() || extractBandName(row.raw_title);
	if (!bandName || bandName.length < 2) {
		console.log(`skip (no band): ${row.raw_title}`);
		continue;
	}

	const norm = bandName.toLowerCase();
	if (seen.has(norm)) {
		console.log(`skip (dup in batch): ${bandName}`);
		continue;
	}
	seen.add(norm);

	const payload = row.raw_payload ?? {};
	const siteId = row.venue?.site_id;
	if (!siteId) continue;

	console.log(`\n→ ${bandName} (${row.venue?.slug})`);
	if (dryRun) continue;

	const res = await fetch(`${WORKER}/generate-artist`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			siteId,
			bandName,
			city: row.venue?.sites?.city ?? null,
			imageUrl: payload.image_url ?? null,
			youtubeEmbed: payload.youtube_embed ?? null,
		}),
	});

	if (!res.ok) {
		console.log(`  FAIL ${res.status}: ${(await res.text()).slice(0, 200)}`);
		failed++;
		continue;
	}

	const result = await res.json();
	console.log(`  artist ${result.artistId} created=${result.created}`);

	const { data: artist } = await supabase
		.from("artists")
		.select("featured_media_id, youtube_embed, youtube_id, genres, seo_title, seo_description, focus_keyphrase")
		.eq("id", result.artistId)
		.single();

	const updatedPayload = {
		...payload,
		artist_media_id: artist?.featured_media_id ?? payload.artist_media_id ?? null,
		youtube_embed: artist?.youtube_embed ?? payload.youtube_embed ?? null,
		youtube_id: artist?.youtube_id ?? payload.youtube_id ?? null,
		genres: artist?.genres ?? payload.genres ?? [],
		seo_title: artist?.seo_title ?? payload.seo_title ?? null,
		seo_description: artist?.seo_description ?? payload.seo_description ?? null,
		focus_keyphrase: artist?.focus_keyphrase ?? payload.focus_keyphrase ?? null,
	};

	const { error: updateError } = await supabase
		.from("ingested_events")
		.update({
			matched_artist_id: result.artistId,
			artist_match_status: "matched",
			extracted_band_name: bandName,
			raw_payload: updatedPayload,
		})
		.eq("id", row.id);

	if (updateError) {
		console.log(`  DB update failed: ${updateError.message}`);
		failed++;
	} else {
		linked++;
		if (result.created) created++;
	}
}

console.log(`\nDone. linked=${linked} new_artists=${created} failed=${failed}`);