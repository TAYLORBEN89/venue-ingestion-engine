/**
 * Create published artist stubs for pending unmatched events (no AI — for quota outages).
 * Usage: node scripts/stub-artists-unmatched.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { extractBandName, normalizeBandNameForMatch } from "../src/lib/parse-band-name.ts";

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

function slugify(name) {
	return name
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 90);
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: pending, error } = await supabase
	.from("ingested_events")
	.select("id, raw_title, extracted_band_name, raw_payload, venue:venues(site_id, slug, sites(city))")
	.eq("review_status", "pending")
	.eq("artist_match_status", "unmatched");

if (error) throw error;

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: existing } = await supabase.from("artists").select("id, name, aliases, slug").eq("site_id", site.id);
const existingNorms = new Set(
	(existing ?? []).flatMap((a) => [a.name, ...(a.aliases ?? [])]).map(normalizeBandNameForMatch),
);

let linked = 0;
for (const row of pending ?? []) {
	const bandName = row.extracted_band_name?.trim() || extractBandName(row.raw_title);
	const norm = normalizeBandNameForMatch(bandName);
	const siteId = row.venue?.site_id ?? site.id;

	let artistId = (existing ?? []).find((a) => normalizeBandNameForMatch(a.name) === norm)?.id ?? null;

	if (!artistId && !existingNorms.has(norm)) {
		const slug = slugify(bandName);
		const { data: created, error: insertError } = await supabase
			.from("artists")
			.insert({
				site_id: siteId,
				slug,
				name: bandName,
				bio: `${bandName} performs live in ${row.venue?.sites?.city ?? "Austin"}. Full artist profile pending AI enrichment.`,
				status: "published",
			})
			.select("id")
			.single();
		if (insertError) {
			console.log(`fail ${bandName}: ${insertError.message}`);
			continue;
		}
		artistId = created.id;
		existingNorms.add(norm);
		console.log(`+ stub artist: ${bandName}`);
	}

	if (!artistId) continue;

	const payload = { ...(row.raw_payload ?? {}) };
	await supabase
		.from("ingested_events")
		.update({
			matched_artist_id: artistId,
			artist_match_status: "matched",
			extracted_band_name: bandName,
			raw_payload: payload,
		})
		.eq("id", row.id);
	linked++;
	console.log(`  linked ${bandName}`);
}

console.log(`\nLinked ${linked} pending rows`);