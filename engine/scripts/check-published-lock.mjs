/**
 * Published events are not rewritten and are never set back to draft.
 * Lock order: archived, trash, published lock, source=manual, series
 * (event_series_id or series_generated), per-field field_sources manual|series,
 * then venue fields, then artist fields.
 * Writes never include status or deleted_at.
 * Known-id load does not select events.source_url.
 *
 * Run from engine/: node --experimental-strip-types scripts/check-published-lock.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshPublishedEventFromVenue } from "../src/lib/refresh-event-from-venue.ts";

const here = dirname(fileURLToPath(import.meta.url));

function mock(row) {
	const writes = [];
	const q = {
		from: () => q,
		select: () => q,
		eq: () => q,
		maybeSingle: async () => ({ data: row ? structuredClone(row) : null, error: null }),
		update: (u) => {
			writes.push(structuredClone(u));
			return { eq: async () => ({ error: null }) };
		},
	};
	return { client: q, writes };
}

const base = {
	id: "e1",
	title: "Old",
	starts_at: "2026-11-22T17:00:00Z",
	ends_at: null,
	ticket_url: "https://t/1",
	price_text: null,
	description: "d",
	source: "partner_import",
	event_series_id: null,
	deleted_at: null,
	status: "draft",
	field_sources: {
		title: "venue",
		starts_at: "venue",
		ends_at: "venue",
		ticket_url: "venue",
		description: "venue",
		seo_title: "artist",
		genres: "artist",
		youtube: "artist",
	},
};

const incoming = {
	title: "New",
	starts_at: "2026-11-21T23:00:00Z",
	ends_at: "2026-11-22T01:00:00Z",
	ticket_url: "https://t/2",
	price_text: "$20",
	description: "new d",
	seo_title: "S",
	seo_description: "SD",
	focus_keyphrase: "fk",
	genres: ["theatre"],
	youtube_id: "yt1",
	youtube_embed: "https://youtube.com/embed/yt1",
};

async function run(row, opts) {
	const m = mock(row);
	const r = await refreshPublishedEventFromVenue(m.client, "e1", incoming, opts);
	return { r, w: m.writes };
}

function assertNoStatus(writes) {
	for (const write of writes) {
		assert.equal("status" in write, false, "writes never include status");
		assert.equal("deleted_at" in write, false, "writes never include deleted_at");
		assert.notEqual(write.status, "draft");
	}
}

// archived before trash, published lock, manual, and series
{
	const { r, w } = await run({
		...base,
		status: "archived",
		deleted_at: "2026-01-01T00:00:00Z",
		source: "manual",
		event_series_id: "s1",
	});
	assert.deepEqual(r, { updated: false, reason: "archived" });
	assert.equal(w.length, 0);
}

// trash before published lock
{
	const { r, w } = await run({
		...base,
		status: "published",
		deleted_at: "2026-01-01T00:00:00Z",
		source: "manual",
	});
	assert.deepEqual(r, { updated: false, reason: "trashed" });
	assert.equal(w.length, 0);
}

// published lock before manual and series. Default and explicit false both lock.
for (const opts of [undefined, {}, { refreshPublished: false }]) {
	const { r, w } = await run(
		{ ...base, status: "published", source: "manual", event_series_id: "s1" },
		opts,
	);
	assert.deepEqual(r, { updated: false, reason: "published_locked" });
	assert.equal(w.length, 0, "a published event is not rewritten");
}

// opt-in refresh of a published manual row stops at the manual lock and does not draft it
{
	const { r, w } = await run(
		{ ...base, status: "published", source: "manual" },
		{ refreshPublished: true },
	);
	assert.deepEqual(r, { updated: false, reason: "manual_event_locked" });
	assert.equal(w.length, 0);
}

// manual before series
{
	const { r, w } = await run({
		...base,
		status: "draft",
		source: "manual",
		event_series_id: "s1",
	});
	assert.deepEqual(r, { updated: false, reason: "manual_event_locked" });
	assert.equal(w.length, 0);
}

// series: event_series_id or series_generated
{
	const byId = await run({ ...base, status: "draft", event_series_id: "s1" });
	assert.deepEqual(byId.r, { updated: false, reason: "series_event_locked" });
	assert.equal(byId.w.length, 0);
	const generated = await run({
		...base,
		status: "draft",
		source: "series_generated",
		event_series_id: null,
	});
	assert.deepEqual(generated.r, { updated: false, reason: "series_event_locked" });
	assert.equal(generated.w.length, 0);
}

// per-field manual|series, then venue, then artist
{
	const { r, w } = await run({
		...base,
		status: "draft",
		field_sources: {
			...base.field_sources,
			title: "manual",
			starts_at: "series",
			seo_title: "artist",
			genres: "manual",
			youtube: "artist",
		},
	});
	assert.equal(r.updated, true);
	assert.equal(w.length, 1);
	assert.equal("title" in w[0], false, "manual title stays");
	assert.equal("starts_at" in w[0], false, "series starts_at stays");
	assert.equal(w[0].ticket_url, incoming.ticket_url, "unlocked venue field updates");
	assert.equal(w[0].seo_title, incoming.seo_title, "artist seo updates after venue fields");
	assert.equal(w[0].youtube_id, incoming.youtube_id);
	assert.equal("genres" in w[0], false, "manual genres stay");
	assert.notEqual(w[0].status, "draft");
	assertNoStatus(w);
}

// published opt-in still never writes status or deleted_at
{
	const { r, w } = await run({ ...base, status: "published" }, { refreshPublished: true });
	assert.equal(r.updated, true);
	assert.equal(w[0].title, "New");
	assertNoStatus(w);
}

// workflow passes refreshPublished false and known-id load skips events.source_url
const workflow = readFileSync(join(here, "../src/workflows/venue-ingestion.ts"), "utf8");
assert.match(workflow, /refreshPublished:\s*false/);
const eventsBlock = workflow.slice(
	workflow.indexOf('.from("events")'),
	workflow.indexOf('.from("ingested_events")'),
);
assert.match(eventsBlock, /\.select\(\s*"source_event_id, ticket_url"\s*\)/);
assert.equal(eventsBlock.includes("source_url"), false, "known-id load does not select events.source_url");

console.log("published-lock check passed");
