/**
 * Cap City Comedy Club pilot — test-source + draft ingest + queue summary.
 * Usage: node scripts/pilot-cap-city.mjs [--probe-only]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const SLUG = "cap-city-comedy-club";
const CALENDAR = "https://www.capcitycomedy.com/calendar";
const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";

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

console.log("\n=== Cap City Comedy pilot ===\n");

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) throw new Error(`Venue not found: ${SLUG} ${vErr?.message ?? ""}`);
console.log("Venue:", venue.name, venue.id);

// Ensure calendar URL + seatengine source (draft only)
await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR,
		website_url: venue.website_url || "https://www.capcitycomedy.com/",
		updated_at: new Date().toISOString(),
	})
	.eq("id", venue.id);

const { data: existing } = await sb
	.from("venue_event_sources")
	.select("id")
	.eq("venue_id", venue.id)
	.limit(1);

let sourceId = existing?.[0]?.id;
if (sourceId) {
	const { error } = await sb
		.from("venue_event_sources")
		.update({
			// Prefer explicit seatengine when DB constraint allows; fall back to auto (detects Cap City)
			platform_type: "seatengine",
			calendar_url: CALENDAR,
			feed_url: CALENDAR,
			publish_mode: "draft",
			is_enabled: true,
			scrape_days_ahead: 120,
			timezone: "America/Chicago",
			updated_at: new Date().toISOString(),
		})
		.eq("id", sourceId);
	if (error) {
		// Older DBs may not allow 'seatengine' in check constraint yet
		const { error: e2 } = await sb
			.from("venue_event_sources")
			.update({
				platform_type: "auto",
				calendar_url: CALENDAR,
				feed_url: CALENDAR,
				publish_mode: "draft",
				is_enabled: true,
				scrape_days_ahead: 120,
				timezone: "America/Chicago",
				updated_at: new Date().toISOString(),
			})
			.eq("id", sourceId);
		if (e2) throw new Error(`source update: ${error.message}; fallback: ${e2.message}`);
		console.log("Updated source", sourceId, "→ auto (seatengine not in DB enum yet) / draft / 120d");
	} else {
		console.log("Updated source", sourceId, "→ seatengine / draft / 120d");
	}
} else {
	const { data: ins, error } = await sb
		.from("venue_event_sources")
		.insert({
			venue_id: venue.id,
			platform_type: "seatengine",
			calendar_url: CALENDAR,
			feed_url: CALENDAR,
			publish_mode: "draft",
			is_enabled: true,
			scrape_days_ahead: 120,
			timezone: "America/Chicago",
		})
		.select("id")
		.single();
	if (error) {
		const { data: ins2, error: e2 } = await sb
			.from("venue_event_sources")
			.insert({
				venue_id: venue.id,
				platform_type: "auto",
				calendar_url: CALENDAR,
				feed_url: CALENDAR,
				publish_mode: "draft",
				is_enabled: true,
				scrape_days_ahead: 120,
				timezone: "America/Chicago",
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

// Probe
console.log("\n--- test-source ---");
const testRes = await fetch(`${WORKER}/test-source`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: CALENDAR,
		venueName: venue.name,
		scrapeDaysAhead: 120,
		platformType: "seatengine",
		websiteUrl: "https://www.capcitycomedy.com/",
		timezone: "America/Chicago",
	}),
});
const testText = await testRes.text();
let test;
try {
	test = JSON.parse(testText);
} catch {
	console.error("test-source non-JSON", testRes.status, testText.slice(0, 400));
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
			sample: (test.events ?? test.sample ?? []).slice?.(0, 5) ?? test.sample_titles,
		},
		null,
		2,
	),
);
if (Array.isArray(test.events)) {
	console.log("sample titles:");
	for (const e of test.events.slice(0, 8)) {
		console.log(" -", e.starts_at ?? e.startsAt, "|", e.title);
	}
}

if (probeOnly) {
	console.log("\n--probe-only: stop before ingest");
	process.exit(test.ready && (test.events_found ?? 0) > 0 ? 0 : 1);
}

if (!test.ready || !(test.events_found > 0)) {
	console.error("Source not ready — abort ingest");
	process.exit(1);
}

// Pending count before
const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending for Cap City before:", before ?? 0);

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

// Poll workflow
console.log("\n--- poll workflow ---");
for (let i = 0; i < 60; i++) {
	await new Promise((r) => setTimeout(r, 5000));
	const stRes = await fetch(`${WORKER}/ingest/${instanceId}`);
	const st = await stRes.json();
	const status = st.status ?? st.state ?? JSON.stringify(st).slice(0, 120);
	console.log(`  [${i + 1}]`, status);
	if (/complete|success|fail|error|terminated/i.test(String(status))) {
		console.log("final", JSON.stringify(st).slice(0, 800));
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
	.select("id, raw_title, parsed_starts_at, review_status, match_status, created_at")
	.eq("venue_id", venue.id)
	.order("created_at", { ascending: false })
	.limit(15);

console.log("\nPending for Cap City after:", after ?? 0);
console.log("Recent rows:");
for (const r of recent ?? []) {
	console.log(
		" -",
		r.review_status,
		r.match_status,
		r.parsed_starts_at,
		"|",
		r.raw_title?.slice(0, 60),
	);
}

const { data: pub } = await sb
	.from("events")
	.select("id, title, starts_at, status, source")
	.eq("venue_id", venue.id)
	.order("starts_at", { ascending: true })
	.gte("starts_at", new Date().toISOString())
	.limit(10);
console.log("\nUpcoming events on venue (any status):", pub?.length ?? 0);
for (const e of pub ?? []) {
	console.log(" -", e.status, e.starts_at, "|", e.title?.slice(0, 50));
}

console.log("\nDone. Review queue: admin /ingestion");
