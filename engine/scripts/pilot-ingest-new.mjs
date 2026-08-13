/**
 * Ingest ONLY never-piloted venues with ready structured feeds.
 * Skips completed pilots, duplicate calendar URLs, and any venue with prior events/ingestion.
 *
 * Usage: node scripts/pilot-ingest-new.mjs [--limit=5] [--probe-limit=30]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { loadNewPilotSources } from "./lib/pilot-venue-filters.mjs";

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
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 5);
const probeLimit = Number(process.argv.find((a) => a.startsWith("--probe-limit="))?.split("=")[1] ?? 40);

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const sources = await loadNewPilotSources(supabase, site.id);

console.log(`\n=== Pilot ingest NEW only (pool=${sources.length}, limit=${limit}) ===\n`);

let queued = 0;
let probed = 0;

for (const source of sources) {
	if (queued >= limit) break;
	if (probed >= probeLimit) break;

	const venue = source.venues;
	probed++;

	const testRes = await fetch(`${WORKER}/test-source`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			calendarUrl: venue.calendar_url ?? venue.event_feed_url ?? source.feed_url,
			feedUrl: source.feed_url ?? venue.event_feed_url,
			platformType: source.platform_type !== "auto" ? source.platform_type : undefined,
			venueName: venue.name,
			venueAddress: venue.address,
			scrapeDaysAhead: 90,
		}),
	});
	const test = await testRes.json();

	if (!test.ready || !(test.events_found > 0)) {
		console.log(`○ skip ${venue.slug} | ${test.events_found ?? 0} ${test.detected_platform ?? test.error ?? ""}`);
		await new Promise((r) => setTimeout(r, 2000));
		continue;
	}

	console.log(`✓ queue ${venue.slug} | ${test.events_found} ${test.detected_platform}`);
	const ingestRes = await fetch(`${WORKER}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ venueId: venue.id, sourceId: source.id }),
	});
	const ingest = await ingestRes.json();
	console.log(`  → ${ingest.instanceId ?? ingest.error ?? JSON.stringify(ingest)}`);
	queued++;
	await new Promise((r) => setTimeout(r, 6000));
}

console.log(`\nQueued ${queued} NEW venue workflows (probed ${probed}).`);
if (queued > 0) {
	console.log("Wait ~1-2 min, then review pending rows in admin /ingestion.");
	console.log("POLICY: AI ingestion is never auto-approved.");
}