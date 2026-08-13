/**
 * Frontyard Brewing pilot — Squarespace Events collection
 *
 * Calendar: https://www.frontyardbrewing.com/upcoming-events
 * API:      ?format=json → { upcoming: EventItem[] }
 *
 * Usage: node scripts/pilot-frontyard.mjs [--probe-only]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const SLUG = "frontyard-brewing";
const CALENDAR = "https://www.frontyardbrewing.com/upcoming-events";
const WEBSITE = "https://www.frontyardbrewing.com/";
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

console.log("\n=== Frontyard Brewing pilot (Squarespace Events) ===\n");

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) {
	const { data: alt } = await sb
		.from("venues")
		.select("id, slug, name")
		.or("slug.ilike.%frontyard%,name.ilike.%frontyard%")
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
	.select("id")
	.eq("venue_id", venue.id)
	.limit(1);

let sourceId = existing?.[0]?.id;
const sourcePayload = {
	platform_type: "squarespace_events",
	calendar_url: CALENDAR,
	feed_url: CALENDAR,
	publish_mode: "draft",
	is_enabled: true,
	scrape_days_ahead: 90,
	timezone: "America/Chicago",
	updated_at: new Date().toISOString(),
};

if (sourceId) {
	const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
	if (error) {
		// Constraint may not allow squarespace_events yet — fall back to auto (HTML detect)
		const { error: e2 } = await sb
			.from("venue_event_sources")
			.update({ ...sourcePayload, platform_type: "auto" })
			.eq("id", sourceId);
		if (e2) throw new Error(`source update: ${error.message}; fallback: ${e2.message}`);
		console.log("Updated source", sourceId, "→ auto / draft / 90d (squarespace_events constraint missing)");
	} else {
		console.log("Updated source", sourceId, "→ squarespace_events / draft / 90d");
	}
} else {
	const { data: ins, error } = await sb
		.from("venue_event_sources")
		.insert({ venue_id: venue.id, ...sourcePayload })
		.select("id")
		.single();
	if (error) {
		const { data: ins2, error: e2 } = await sb
			.from("venue_event_sources")
			.insert({ venue_id: venue.id, ...sourcePayload, platform_type: "auto" })
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
		scrapeDaysAhead: 90,
		platformType: "squarespace_events",
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
			platform_label: test.platform_label,
			has_images: test.has_images,
			has_ticket_links: test.has_ticket_links,
			messages: test.messages,
			sample_titles: test.sample_titles,
			error: test.error,
		},
		null,
		2,
	),
);

if (probeOnly) {
	console.log("\n--probe-only: stop before ingest");
	process.exit(test.ready && (test.events_found ?? 0) > 0 ? 0 : 1);
}

if (!test.ready || !(test.events_found > 0)) {
	console.error("Source not ready — abort ingest (deploy ingestion worker with squarespace_events first?)");
	process.exit(1);
}

const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending for Frontyard before:", before ?? 0);

console.log("\n--- ingest (draft) ---");
const ingestRes = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ venueId: venue.id, sourceId }),
});
const ingestText = await ingestRes.text();
let ingest;
try {
	ingest = JSON.parse(ingestText);
} catch {
	console.error("ingest non-JSON", ingestRes.status, ingestText.slice(0, 500));
	process.exit(1);
}
console.log(ingest);
const instanceId = ingest.instanceId ?? ingest.id;
if (!instanceId) {
	console.error("No workflow instance id");
	process.exit(1);
}

console.log("\n--- poll workflow ---");
for (let i = 0; i < 60; i++) {
	await new Promise((r) => setTimeout(r, 5000));
	const stRes = await fetch(`${WORKER}/ingest/${instanceId}`);
	const st = await stRes.json();
	const statusVal =
		typeof st.status === "string"
			? st.status
			: st.status?.status ?? st.state ?? JSON.stringify(st).slice(0, 120);
	console.log(`  [${i + 1}]`, statusVal);
	if (/complete|success|fail|error|terminated/i.test(String(statusVal))) {
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
	.select("id, raw_title, parsed_starts_at, review_status, match_status, source_url, ticket_url")
	.eq("venue_id", venue.id)
	.order("created_at", { ascending: false })
	.limit(25);

console.log("\nPending for Frontyard after:", after ?? 0);
console.log("Recent ingested_events:");
for (const r of recent ?? []) {
	console.log(
		" -",
		r.review_status,
		r.match_status,
		r.parsed_starts_at,
		"|",
		r.raw_title?.slice(0, 55),
		"| tix",
		!!r.ticket_url,
	);
}

console.log("\n=== Frontyard pilot done (draft mode) ===");
