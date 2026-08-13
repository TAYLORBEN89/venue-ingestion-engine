/**
 * Speakeasy Austin pilot — configure draft EventON source + test-source (+ optional ingest).
 * Usage: node scripts/pilot-speakeasy.mjs [--probe-only] [--local-smoke]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const localSmoke = process.argv.includes("--local-smoke");
const SLUG = "speakeasy";
// EventON UI calendar: #evcal_list + #evcal_next (not the thin /events/ archive shell)
const CALENDAR = "https://speakeasyaustin.com/calendar/";
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

console.log("\n=== Speakeasy Austin pilot (EventON) ===\n");

if (localSmoke) {
	console.log("--- local smoke (no worker) ---\n");
	const r = spawnSync(process.execPath, [resolve(__dirname, "smoke-eventon-speakeasy.mjs")], {
		stdio: "inherit",
		cwd: resolve(__dirname, ".."),
	});
	process.exit(r.status ?? 1);
}

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) {
	// try alternate slugs
	const { data: alt } = await sb
		.from("venues")
		.select("id, slug, name, calendar_url, website_url, address, status")
		.or("slug.eq.speakeasy-austin,name.ilike.%speakeasy%")
		.limit(5);
	console.error("Venue not found for slug", SLUG, vErr?.message ?? "");
	console.error("Candidates:", alt);
	process.exit(1);
}
console.log("Venue:", venue.name, venue.id, venue.slug);

await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR,
		website_url: venue.website_url || "https://speakeasyaustin.com/",
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
	platform_type: "eventon",
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
		const { error: e2 } = await sb
			.from("venue_event_sources")
			.update({ ...sourcePayload, platform_type: "auto" })
			.eq("id", sourceId);
		if (e2) throw new Error(`source update: ${error.message}; fallback: ${e2.message}`);
		console.log("Updated source", sourceId, "→ auto (eventon rejected) / draft / 120d");
	} else {
		console.log("Updated source", sourceId, "→ eventon / draft / 120d");
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
		scrapeDaysAhead: 120,
		platformType: "eventon",
		timezone: "America/Chicago",
	}),
});
const testText = await testRes.text();
let test;
try {
	test = JSON.parse(testText);
} catch {
	console.error("test-source non-JSON", testRes.status, testText.slice(0, 500));
	console.error("\nWorker may not have EventON yet — run with --local-smoke or deploy ingestion.");
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
	console.error("Source not ready — abort ingest (try deploy + re-run, or --local-smoke)");
	process.exit(1);
}

// Pending count before
const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending for Speakeasy before:", before ?? 0);

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
	.limit(20);

console.log("\nPending for Speakeasy after:", after ?? 0);
console.log("Recent ingested_events:");
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
	.limit(15);

console.log("\nPublished events (upcoming):", (pub ?? []).length);
for (const e of pub ?? []) {
	console.log(" -", e.status, e.starts_at, "|", e.title?.slice(0, 50));
}

console.log("\n=== Speakeasy pilot done (draft mode) ===");
