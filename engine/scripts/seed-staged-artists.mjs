/**
 * Seed published artist stubs from pending ingested_events extracted_band_name values.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { normalizeBandNameForMatch } from "../src/lib/parse-band-name.ts";

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

function slugify(name) {
	return name
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 90);
}

const { data: pending, error } = await supabase
	.from("ingested_events")
	.select("extracted_band_name, venues(site_id)")
	.eq("review_status", "pending")
	.not("extracted_band_name", "is", null);

if (error) throw error;
if (!pending?.length) {
	console.log("No pending events.");
	process.exit(0);
}

const siteId = pending[0].venues?.site_id;
const { data: existing, error: existingError } = await supabase
	.from("artists")
	.select("slug, name, aliases")
	.eq("site_id", siteId);
if (existingError) throw existingError;

const existingSlugs = new Set((existing ?? []).map((a) => a.slug));
const existingNorms = new Set(
	(existing ?? []).flatMap((a) => [a.name, ...(a.aliases ?? [])]).map(normalizeBandNameForMatch).filter(Boolean),
);

const candidates = new Map();
for (const row of pending) {
	const name = row.extracted_band_name?.trim();
	if (!name || name.length < 2) continue;
	const norm = normalizeBandNameForMatch(name);
	if (!norm || existingNorms.has(norm)) continue;

	const slug = slugify(name);
	if (existingSlugs.has(slug) || candidates.has(slug)) continue;
	candidates.set(slug, { site_id: siteId, slug, name, status: "published" });
}

const rows = [...candidates.values()];
if (rows.length === 0) {
	console.log("No new artists to seed from staged events.");
	process.exit(0);
}

const { data: inserted, error: insertError } = await supabase.from("artists").insert(rows).select("name, slug");
if (insertError) {
	console.error("Insert failed:", insertError.message);
	process.exit(1);
}

console.log(`Seeded ${inserted?.length ?? 0} artists from staged events:`);
for (const a of inserted ?? []) console.log(`  • ${a.name}`);