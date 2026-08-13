/**
 * Circuit of The Americas pilot
 *
 * List: https://circuitoftheamericas.com/events/?layout=list
 * Skips Concerts / germaniaamp.com rows (owned by Germania Amp pilot).
 *
 * Usage (from apps/ingestion):
 *   node scripts/pilot-cota.mjs --probe-only
 *   node scripts/pilot-cota.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const SLUG = "circuit-of-the-americas";
const CALENDAR = "https://circuitoftheamericas.com/events/?layout=list";
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

console.log("\n=== Circuit of The Americas pilot ===\n");

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) throw new Error(`Venue not found: ${SLUG} ${vErr?.message ?? ""}`);
console.log("Venue:", venue.name, venue.id);

await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR,
		website_url: venue.website_url || "https://circuitoftheamericas.com/",
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
	calendar_url: CALENDAR,
	feed_url: CALENDAR,
	// custom_html if DB rejects cota enum; worker detects circuitoftheamericas.com
	platform_type: "custom_html",
	publish_mode: "draft",
	is_enabled: true,
	scrape_days_ahead: 365,
	timezone: "America/Chicago",
	updated_at: new Date().toISOString(),
};

if (sourceId) {
	const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
	if (error) {
		// try without timezone if column issue
		const { error: e2 } = await sb
			.from("venue_event_sources")
			.update({
				calendar_url: CALENDAR,
				feed_url: CALENDAR,
				platform_type: "auto",
				publish_mode: "draft",
				is_enabled: true,
				scrape_days_ahead: 365,
				updated_at: new Date().toISOString(),
			})
			.eq("id", sourceId);
		if (e2) throw new Error(`source update: ${error.message}; fallback ${e2.message}`);
		console.log("Updated source", sourceId, "(auto fallback)");
	} else {
		console.log("Updated source", sourceId, "→ list calendar / draft / 400d");
	}
} else {
	const { data: ins, error } = await sb
		.from("venue_event_sources")
		.insert({ venue_id: venue.id, ...sourcePayload })
		.select("id")
		.single();
	if (error) throw new Error(`source insert: ${error.message}`);
	sourceId = ins.id;
	console.log("Created source", sourceId);
}

console.log("\n--- test-source ---");
const testRes = await fetch(`${WORKER}/test-source`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: CALENDAR,
		venueName: venue.name,
		venueAddress: venue.address,
		scrapeDaysAhead: 365,
		platformType: "custom_html",
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
			method: test.method,
			error: test.error,
		},
		null,
		2,
	),
);

const sample = test.events ?? test.sample ?? [];
if (Array.isArray(sample) && sample.length) {
	console.log("\nsample:");
	for (const e of sample.slice(0, 15)) {
		console.log(
			`  · ${String(e.starts_at || e.startsAt || "").slice(0, 10)}  ${e.title}${e.ticket_url ? "  [tix]" : ""}`,
		);
	}
}

const ready = test.ready && (test.events_found ?? 0) > 0;
if (!ready) {
	console.error("\n○ Not ready — deploy ingestion worker with cota-events adapter.");
	process.exit(1);
}

if (probeOnly) {
	console.log("\n✓ Probe only — skip ingest.");
	process.exit(0);
}

const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending before:", before ?? 0);

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
for (let i = 0; i < 48; i++) {
	await new Promise((r) => setTimeout(r, 5000));
	const stRes = await fetch(`${WORKER}/ingest/${instanceId}`);
	const st = await stRes.json();
	const status = st.status ?? st.state ?? JSON.stringify(st).slice(0, 120);
	console.log(`  [${i + 1}]`, status);
	if (/complete|success|fail|error|terminated/i.test(String(status))) {
		console.log("final", JSON.stringify(st).slice(0, 1000));
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
	.select("id, raw_title, parsed_starts_at, review_status, match_status, source_url")
	.eq("venue_id", venue.id)
	.order("created_at", { ascending: false })
	.limit(20);

console.log("\nPending after:", after ?? 0);
console.log("Recent:");
for (const r of recent ?? []) {
	console.log(
		" -",
		r.review_status,
		r.parsed_starts_at?.slice?.(0, 10),
		"|",
		r.raw_title?.slice(0, 55),
	);
}

console.log("\nDone. Review: admin /ingestion (Circuit of The Americas)\n");
