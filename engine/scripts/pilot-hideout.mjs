/**
 * Hideout Theatre pilot — WordPress Events Manager calendar.
 *
 * Calendar: https://hideouttheatre.com/calendar/
 * Multi-month via ?mo=N&yr=YYYY; cards: .event_notes / .event_name / flyer / event_id
 *
 * Usage:
 *   node scripts/pilot-hideout.mjs --probe-only
 *   node scripts/pilot-hideout.mjs --ingest
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const doIngest = process.argv.includes("--ingest");
const SLUG = "the-hideout-theatre";
const CALENDAR = "https://hideouttheatre.com/calendar/";
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

console.log("\n=== Hideout Theatre pilot (Events Manager) ===\n");

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) {
	console.error("Venue not found", SLUG, vErr?.message);
	process.exit(1);
}
console.log("Venue:", venue.name, venue.id);

await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR,
		website_url: venue.website_url || "https://hideouttheatre.com/",
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
	// DB may not allow events_manager yet — auto still detects hideouttheatre.com
	platform_type: "auto",
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
	if (error) throw error;
	console.log("Updated source", sourceId);
} else {
	const { data: created, error } = await sb
		.from("venue_event_sources")
		.insert({ venue_id: venue.id, ...sourcePayload, created_at: new Date().toISOString() })
		.select("id")
		.single();
	if (error) throw error;
	sourceId = created.id;
	console.log("Created source", sourceId);
}

console.log("\n--- test-source ---\n");
const testRes = await fetch(`${WORKER}/test-source`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: CALENDAR,
		platformType: "auto",
		scrapeDaysAhead: 120,
		venueName: venue.name,
		venueId: venue.id,
	}),
});
const test = await testRes.json();
console.log(
	JSON.stringify(
		{
			status: testRes.status,
			ready: test.ready,
			events_found: test.events_found,
			detected_platform: test.detected_platform,
			has_images: test.has_images,
			sample_titles: test.sample_titles,
			messages: test.messages,
			error: test.error,
		},
		null,
		2,
	),
);

if (probeOnly) {
	process.exit(test.ready && (test.events_found ?? 0) > 0 ? 0 : 1);
}

if (!doIngest) {
	console.log("\n(pass --ingest to enqueue workflow)");
	process.exit(0);
}

if (!test.ready || !(test.events_found > 0)) {
	console.error("Not ready — deploy ingestion with Events Manager source, then re-run");
	process.exit(1);
}

console.log("\n--- ingest ---\n");
const ingestRes = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ venueId: venue.id, sourceId }),
});
console.log(ingestRes.status, await ingestRes.text());
console.log("\nDone. Review pending for", SLUG);
