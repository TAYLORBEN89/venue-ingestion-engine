/**
 * Probe and ingest remaining Wave 1 venues (skip antones unless --all).
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devVars = readFileSync(resolve(__dirname, "../.dev.vars"), "utf8");
const env = Object.fromEntries(
	devVars
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";

const WAVE_1 = ["the-mohawk", "stubbs-bar-b-q", "hotel-vegas", "moody-amphitheater-austin"];
const includeAll = process.argv.includes("--all");

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const slugs = includeAll ? [...WAVE_1, "antones-nightclub"] : WAVE_1;
const { data: venues } = await supabase
	.from("venues")
	.select("id, slug, name, calendar_url, address")
	.eq("site_id", site.id)
	.in("slug", slugs);

console.log("\n=== Wave 1 ingest ===\n");

for (const venue of venues ?? []) {
	const testRes = await fetch(`${WORKER}/test-source`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			calendarUrl: venue.calendar_url,
			venueName: venue.name,
			venueAddress: venue.address,
			scrapeDaysAhead: 90,
		}),
	});
	const test = await testRes.json();
	const ready = test.ready && test.events_found > 0;
	console.log(`${ready ? "✓" : "○"} ${venue.name} | ${test.detected_platform} | events=${test.events_found ?? 0}`);
	if (!ready) {
		console.log(`  skip: ${test.error ?? test.messages?.[0] ?? "not ready"}\n`);
		continue;
	}

	const { data: sources } = await supabase.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
	const ingestRes = await fetch(`${WORKER}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ venueId: venue.id, sourceId: sources?.[0]?.id }),
	});
	const ingest = await ingestRes.json();
	console.log(`  → ${ingest.instanceId ?? ingest.error}\n`);
	await new Promise((r) => setTimeout(r, 3000));
}

await new Promise((r) => setTimeout(r, 12000));
const { count } = await supabase
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending");
console.log(`Pending in queue: ${count ?? 0}`);