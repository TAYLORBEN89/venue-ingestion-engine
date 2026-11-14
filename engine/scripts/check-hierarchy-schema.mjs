/**
 * Hierarchy columns copied from ThinAirSolutionsBuild schema files.
 * match_status and matched_event_id stay in 001 (not re-added here).
 * 004 copies focus_keyphrase onto events and venues only. sites.city backfill is omitted.
 *
 * Run from engine/: node scripts/check-hierarchy-schema.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "../../schema");

function sql(name) {
	return readFileSync(join(schemaDir, name), "utf8");
}

function has(file, needle) {
	assert.ok(file.includes(needle), `missing ${JSON.stringify(needle)}`);
}

const initial = sql("001_initial_schema.sql");
has(initial, "match_status");
has(initial, "matched_event_id");
assert.equal(initial.includes("extracted_band_name"), false);
assert.equal(initial.includes("event_series_id"), false);
assert.equal(initial.includes("field_sources"), false);

const seo = sql("003_venue_event_seo_fields.sql");
has(seo, "ThinAirSolutionsBuild schema/003_venue_event_seo_fields.sql");
has(seo, "alter table venues");
has(seo, "add column seo_title text");
has(seo, "add column seo_description text");
has(seo, "alter table events");

const focus = sql("004_seo_focus_keyphrase.sql");
has(focus, "ThinAirSolutionsBuild schema/004_seo_focus_keyphrase.sql");
has(focus, "alter table events add column focus_keyphrase text");
has(focus, "alter table venues add column focus_keyphrase text");
assert.equal(/alter table sites add column city/i.test(focus), false, "sites.city omitted");
assert.equal(/update sites set city/i.test(focus), false, "sites.city backfill omitted");

const bands = sql("006_band_catalog.sql");
has(bands, "ThinAirSolutionsBuild schema/006_band_catalog.sql");
has(bands, "add column aliases text[] not null default '{}'");
has(bands, "add column seo_title text");
has(bands, "add column seo_description text");
has(bands, "add column focus_keyphrase text");
has(bands, "add column extracted_band_name text");
has(bands, "add column matched_artist_id uuid references artists(id) on delete set null");
has(bands, "add column artist_match_status text");
has(bands, "create index idx_artists_site_name on artists (site_id, lower(name))");

const youtube = sql("007_artist_youtube_genres.sql");
has(youtube, "ThinAirSolutionsBuild schema/007_artist_youtube_genres.sql");
has(youtube, "alter table artists");
has(youtube, "add column youtube_embed text");
has(youtube, "add column youtube_id text");
has(youtube, "add column genres text[] not null default '{}'");
has(youtube, "alter table events");
has(youtube, "create index idx_artists_youtube_id on artists (youtube_id) where youtube_id is not null");

const enrichment = sql("019_artist_enrichment_fields.sql");
has(enrichment, "ThinAirSolutionsBuild schema/019_artist_enrichment_fields.sql");
has(enrichment, "add column if not exists field_sources jsonb not null default '{}'::jsonb");
has(enrichment, "add column if not exists billing_order smallint not null default 0");
has(enrichment, "add column if not exists role text not null default 'headliner'");
has(enrichment, "create index if not exists event_artists_event_order_idx");
has(enrichment, "on event_artists (event_id, billing_order)");

const trash = sql("021_soft_delete_trash.sql");
has(trash, "ThinAirSolutionsBuild schema/021_soft_delete_trash.sql");
for (const table of [
	"events",
	"venues",
	"artists",
	"deals",
	"posts",
	"rentals",
	"categories",
	"regions",
]) {
	has(trash, `alter table ${table} add column if not exists deleted_at timestamptz`);
	has(
		trash,
		`create index if not exists idx_${table}_deleted_at on ${table} (deleted_at) where deleted_at is not null`,
	);
}

const series = sql("028_event_series.sql");
has(series, "ThinAirSolutionsBuild schema/028_event_series.sql");
has(series, "create table if not exists event_series");
has(series, "deleted_at          timestamptz");
has(series, "add column if not exists event_series_id uuid references event_series(id) on delete set null");
has(series, "add column if not exists matched_series_id uuid references event_series(id) on delete set null");
has(series, "create index if not exists event_series_site_idx");
has(series, "create index if not exists event_series_venue_idx");
has(series, "create index if not exists events_event_series_id_idx");

console.log("hierarchy schema check passed");
