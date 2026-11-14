/**
 * Hierarchy columns copied from ThinAirSolutionsBuild schema files.
 * match_status and matched_event_id stay in 001 (not re-added here).
 * 004 copies focus_keyphrase onto events and venues only. sites.city backfill is omitted.
 *
 * Run from engine/: node scripts/check-hierarchy-schema.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaDir = join(root, "schema");
const srcDir = join(root, "engine/src");

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

/** Line comments do not define columns. Quotes are preserved so '--' inside a string stays. */
function stripSqlComments(text) {
	return text
		.split("\n")
		.map((line) => {
			let out = "";
			let inQuote = false;
			for (let i = 0; i < line.length; i++) {
				const c = line[i];
				if (c === "'" && line[i - 1] !== "\\") inQuote = !inQuote;
				if (!inQuote && c === "-" && line[i + 1] === "-") break;
				out += c;
			}
			return out;
		})
		.join("\n");
}

const commentOnly = stripSqlComments("-- alter table events add column source_url text;\nselect 1;\n");
assert.equal(/\bsource_url\b/.test(commentOnly), false, "a -- comment must not define a column");

function splitTopLevel(body) {
	const parts = [];
	let depth = 0;
	let cur = "";
	for (const c of body) {
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		if (c === "," && depth === 0) {
			parts.push(cur);
			cur = "";
		} else cur += c;
	}
	if (cur.trim()) parts.push(cur);
	return parts;
}

const SKIP_LEADING = new Set([
	"unique",
	"primary",
	"constraint",
	"check",
	"foreign",
	"exclude",
	"references",
]);

function addCreateColumns(sql, columns) {
	const createRe =
		/create table(?:\s+if\s+not\s+exists)?\s+(events|ingested_events|event_series)\s*\(([\s\S]*?)\);/gi;
	for (const match of sql.matchAll(createRe)) {
		const table = match[1].toLowerCase();
		for (const part of splitTopLevel(match[2])) {
			const name = part.match(/^\s*([a-z_][a-z0-9_]*)\b/i)?.[1]?.toLowerCase();
			if (!name || SKIP_LEADING.has(name)) continue;
			columns[table].add(name);
		}
	}
}

function addAlterColumns(sql, columns) {
	const alterRe = /alter table\s+(events|ingested_events|event_series)\b([\s\S]*?);/gi;
	for (const match of sql.matchAll(alterRe)) {
		const table = match[1].toLowerCase();
		const addRe = /add column(?:\s+if\s+not\s+exists)?\s+([a-z_][a-z0-9_]*)/gi;
		for (const add of match[2].matchAll(addRe)) columns[table].add(add[1].toLowerCase());
	}
}

function definedHierarchyColumns() {
	const columns = { events: new Set(), ingested_events: new Set(), event_series: new Set() };
	for (const name of readdirSync(schemaDir)) {
		if (!name.endsWith(".sql")) continue;
		const sql = stripSqlComments(readFileSync(join(schemaDir, name), "utf8"));
		addCreateColumns(sql, columns);
		addAlterColumns(sql, columns);
	}
	return columns;
}

function queryChains(source, table) {
	const chains = [];
	const needle = `.from("${table}")`;
	let from = 0;
	while (from < source.length) {
		const start = source.indexOf(needle, from);
		if (start === -1) break;
		const next = source.indexOf('.from("', start + needle.length);
		chains.push(source.slice(start, next === -1 ? source.length : next));
		from = start + needle.length;
	}
	return chains;
}

function columnsInChain(chain) {
	const found = new Set();
	for (const sel of chain.matchAll(/\.select\(\s*"([^"]*)"\s*\)/g)) {
		for (const col of sel[1].split(",")) {
			const name = col.trim().toLowerCase();
			if (name) found.add(name);
		}
	}
	for (const filter of chain.matchAll(/\.(?:is|eq|neq|in)\(\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g)) {
		found.add(filter[1].toLowerCase());
	}
	return found;
}

function insertKeysBeforeRawPayload(source) {
	const keys = new Set();
	if (!source.includes('.from("ingested_events")') || !source.includes(".insert(")) return keys;
	const payload = source.indexOf("raw_payload:");
	if (payload === -1) return keys;
	const open = source.lastIndexOf("({", payload);
	if (open === -1) return keys;
	for (const line of source.slice(open, payload).split("\n")) {
		const key = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/)?.[1]?.toLowerCase();
		if (key) keys.add(key);
	}
	return keys;
}

const HIERARCHY_FILES = [
	"lib/refresh-event-from-venue.ts",
	"workflows/venue-ingestion.ts",
	"lib/dedup.ts",
	"lib/match-event-series.ts",
];

const defined = definedHierarchyColumns();
assert.equal(defined.events.has("source_url"), false, "events.source_url is not a schema column");
assert.equal(defined.ingested_events.has("source_url"), true);
assert.equal(defined.events.has("field_sources"), true);
assert.equal(defined.events.has("event_series_id"), true);
assert.equal(defined.events.has("deleted_at"), true);
assert.equal(defined.event_series.has("deleted_at"), true);
assert.equal(defined.ingested_events.has("matched_series_id"), true);

const missing = [];
for (const rel of HIERARCHY_FILES) {
	const source = readFileSync(join(srcDir, rel), "utf8");
	for (const table of ["events", "event_series", "ingested_events"]) {
		for (const chain of queryChains(source, table)) {
			for (const col of columnsInChain(chain)) {
				if (!defined[table].has(col)) missing.push(`${rel} ${table}.${col}`);
			}
		}
	}
	if (rel.endsWith("refresh-event-from-venue.ts")) {
		for (const assign of source.matchAll(/\bupdates\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g)) {
			const col = assign[1].toLowerCase();
			if (!defined.events.has(col)) missing.push(`${rel} events.${col} (updates)`);
		}
	}
	if (rel.endsWith("venue-ingestion.ts")) {
		for (const col of insertKeysBeforeRawPayload(source)) {
			if (!defined.ingested_events.has(col)) missing.push(`${rel} ingested_events.${col} (insert)`);
		}
	}
}

const knownId = readFileSync(join(srcDir, "workflows/venue-ingestion.ts"), "utf8");
const eventsChain = queryChains(knownId, "events").join("\n");
assert.equal(
	eventsChain.includes("source_url"),
	false,
	"known-id query must not select events.source_url",
);

assert.deepEqual(missing, [], `hierarchy code uses columns schema/ does not define:\n${missing.join("\n")}`);

console.log("hierarchy schema check passed");
