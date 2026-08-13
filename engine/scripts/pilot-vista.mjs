/**
 * Vista Brewing pilot — Squarespace Events collection (eventlist)
 *
 * Calendar: https://www.vistabrewingtx.com/calendars
 * Structure: div.eventlist.eventlist--upcoming > article.eventlist-event
 * Images: a.eventlist-column-thumbnail[data-image|data-src] (list)
 *         JSON-LD Event.image / same CDN asset on detail (?format=1500w)
 *
 * Usage: node scripts/pilot-vista.mjs [--probe-only]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const SLUG = "vista-brewing";
const CALENDAR = "https://www.vistabrewingtx.com/calendars";
const WEBSITE = "https://www.vistabrewingtx.com/";
const WORKER =
	process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";

const devVars = readFileSync(resolve(__dirname, "../.dev.vars"), "utf8");
const env = Object.fromEntries(
	devVars
		.split(/\r?\n/)
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

console.log("\n=== Vista Brewing pilot (Squarespace Events / eventlist) ===\n");

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) {
	const { data: alt } = await sb
		.from("venues")
		.select("id, slug, name")
		.or("slug.ilike.%vista%,name.ilike.%vista brew%")
		.limit(8);
	console.error("Venue not found:", SLUG, vErr?.message ?? "");
	console.error("Candidates:", alt);
	process.exit(1);
}
console.log("Venue:", venue.name, venue.id, venue.slug);

await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR,
		website_url: venue.website_url || WEBSITE,
		updated_at: new Date().toISOString(),
	})
	.eq("id", venue.id);

const { data: existing } = await sb
	.from("venue_event_sources")
	.select("id, platform_type, calendar_url")
	.eq("venue_id", venue.id)
	.limit(5);

let sourceId = existing?.[0]?.id;
const sourcePayload = {
	platform_type: "squarespace_events",
	calendar_url: CALENDAR,
	feed_url: CALENDAR,
	publish_mode: "draft",
	is_enabled: true,
	scrape_days_ahead: 120,
	timezone: "America/Chicago",
	updated_at: new Date().toISOString(),
};

if (sourceId) {
	const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
	if (error) {
		// platform enum may not include squarespace_events yet
		const { error: e2 } = await sb
			.from("venue_event_sources")
			.update({ ...sourcePayload, platform_type: "auto" })
			.eq("id", sourceId);
		if (e2) throw new Error(`source update: ${error.message}; fallback: ${e2.message}`);
		console.log("Updated source", sourceId, "→ auto (squarespace_events enum fallback)");
	} else {
		console.log("Updated source", sourceId, "→ squarespace_events / draft / 120d");
	}
} else {
	const { data: ins, error } = await sb
		.from("venue_event_sources")
		.insert({
			venue_id: venue.id,
			...sourcePayload,
		})
		.select("id")
		.single();
	if (error) {
		const { data: ins2, error: e2 } = await sb
			.from("venue_event_sources")
			.insert({
				venue_id: venue.id,
				...sourcePayload,
				platform_type: "auto",
			})
			.select("id")
			.single();
		if (e2) throw new Error(`source insert: ${error.message}; fallback: ${e2.message}`);
		sourceId = ins2.id;
		console.log("Created source", sourceId, "(auto)");
	} else {
		sourceId = ins.id;
		console.log("Created source", sourceId);
	}
}

console.log("\n--- test-source ---");
const testRes = await fetch(`${WORKER}/test-source`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: CALENDAR,
		venueName: venue.name,
		venueAddress: venue.address,
		scrapeDaysAhead: 120,
		platformType: "squarespace_events",
		websiteUrl: WEBSITE,
		timezone: "America/Chicago",
	}),
});
const testText = await testRes.text();
let test;
try {
	test = JSON.parse(testText);
} catch {
	console.error("test-source non-JSON", testRes.status, testText.slice(0, 500));
	process.exit(1);
}
console.log(
	JSON.stringify(
		{
			status: testRes.status,
			ready: test.ready,
			events_found: test.events_found,
			detected_platform: test.detected_platform,
			error: test.error,
		},
		null,
		2,
	),
);

const sample = test.events ?? test.sample ?? [];
if (Array.isArray(sample) && sample.length) {
	console.log("\nsample events:");
	for (const e of sample.slice(0, 10)) {
		console.log(
			" -",
			(e.starts_at ?? e.startsAt ?? "").toString().slice(0, 16),
			"|",
			(e.title || "").slice(0, 42).padEnd(42),
			"|",
			e.image_url ? "img" : "NOIMG",
			"|",
			(e.source_url || "").replace(WEBSITE.replace(/\/$/, ""), "").slice(0, 50),
		);
	}
	const withImg = sample.filter((e) => e.image_url).length;
	console.log(`images in sample: ${withImg}/${Math.min(sample.length, 10)} (of ${sample.length} returned)`);
}

if (probeOnly) {
	console.log("\n--probe-only: stop before ingest");
	process.exit(test.ready && (test.events_found ?? 0) > 0 ? 0 : 1);
}

if (!test.ready || !(test.events_found > 0)) {
	console.error("Source not ready — abort ingest");
	process.exit(1);
}

const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending for Vista before:", before ?? 0);

console.log("\n--- ingest ---");
const ingestRes = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ venueId: venue.id, sourceId }),
});
const ingest = await ingestRes.json();
console.log(ingest);
const instanceId = ingest.instanceId ?? ingest.id;
if (!instanceId) {
	console.error("No workflow instance id");
	process.exit(1);
}

console.log("\n--- poll workflow ---");
for (let i = 0; i < 40; i++) {
	await new Promise((r) => setTimeout(r, 5000));
	const stRes = await fetch(`${WORKER}/ingest/${instanceId}`);
	const st = await stRes.json();
	const status = st.status?.status ?? st.status ?? JSON.stringify(st).slice(0, 80);
	console.log(`  [${i + 1}]`, status);
	if (/complete|success|fail|error|terminated/i.test(String(status))) {
		console.log("final", JSON.stringify(st).slice(0, 900));
		break;
	}
}

const { count: after } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);

const { data: recent } = await sb
	.from("ingested_events")
	.select("id, raw_title, parsed_starts_at, review_status, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.order("parsed_starts_at", { ascending: true })
	.limit(15);

console.log("\nPending for Vista after:", after ?? 0);
for (const r of recent ?? []) {
	console.log(
		" -",
		r.parsed_starts_at?.slice(0, 16),
		"|",
		(r.raw_title || "").slice(0, 40).padEnd(40),
		"|",
		r.raw_payload?.image_url ? "img" : "NOIMG",
	);
}
console.log("\nDone. Review: admin /ingestion → Vista Brewing");
