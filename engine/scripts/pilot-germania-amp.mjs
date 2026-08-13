/**
 * Germania Insurance Amphitheater pilot
 *
 * List:  http://germaniaamp.com/events/  (div.card.events in .upcoming-shows)
 * Detail: time, Ticketmaster URL, About the Artist cards
 *
 * Usage (from apps/ingestion):
 *   node scripts/pilot-germania-amp.mjs --probe-only
 *   node scripts/pilot-germania-amp.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const SLUG = "germania-insurance-amphitheater";
const CALENDAR = "http://germaniaamp.com/events/";
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

console.log("\n=== Germania Insurance Amphitheater pilot ===\n");

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
		website_url: venue.website_url || "http://germaniaamp.com/",
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
	// Prefer custom_html so older DBs accept; worker detects germaniaamp.com → germania adapter
	platform_type: "custom_html",
	publish_mode: "draft",
	is_enabled: true,
	scrape_days_ahead: 200,
	timezone: "America/Chicago",
	updated_at: new Date().toISOString(),
};

if (sourceId) {
	const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
	if (error) throw new Error(`source update: ${error.message}`);
} else {
	const { data: ins, error } = await sb
		.from("venue_event_sources")
		.insert({ venue_id: venue.id, ...sourcePayload })
		.select("id")
		.single();
	if (error) throw new Error(`source insert: ${error.message}`);
	sourceId = ins.id;
}
console.log("Source:", sourceId, CALENDAR);

const testRes = await fetch(`${WORKER}/test-source`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: CALENDAR,
		venueName: venue.name,
		address: venue.address,
		scrapeDaysAhead: 200,
		platformType: "custom_html",
	}),
});
const test = await testRes.json();
console.log("\ntest-source:", {
	ready: test.ready,
	events_found: test.events_found,
	platform: test.detected_platform ?? test.platform,
	method: test.method,
	error: test.error,
});
if (Array.isArray(test.events)) {
	for (const e of test.events.slice(0, 12)) {
		console.log(
			`  · ${String(e.starts_at || "").slice(0, 16)}  ${e.title}${e.ticket_url ? "  [tm]" : ""}`,
		);
	}
	if (test.events.length > 12) console.log(`  … +${test.events.length - 12} more`);
}

const ready = test.ready && (test.events_found ?? 0) > 0;
if (!ready) {
	console.log("\n○ Not ready — deploy ingestion worker with germania-amp adapter if events_found=0.");
	process.exit(1);
}

if (probeOnly) {
	console.log("\n✓ Probe only — skip ingest.");
	process.exit(0);
}

const ingestRes = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ venueId: venue.id, sourceId }),
});
const ingest = await ingestRes.json();
console.log("\ningest:", ingest.instanceId ?? ingest.error ?? ingest);

if (ingest.instanceId) {
	console.log("Waiting 45s for workflow…");
	await new Promise((r) => setTimeout(r, 45000));
	const { count } = await sb
		.from("ingested_events")
		.select("id", { count: "exact", head: true })
		.eq("venue_id", venue.id)
		.eq("review_status", "pending");
	console.log(`Pending review for ${SLUG}: ${count ?? 0}`);
}

console.log("\nDone.\n");
