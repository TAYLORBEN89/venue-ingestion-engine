/**
 * @deprecated Use pilot-new.mjs — Wave 1 re-ingests completed pilots.
 * Usage: node scripts/pilot-start.mjs [--probe-only] [--venue=slug]
 */
console.warn("DEPRECATED: use `node scripts/pilot-new.mjs` for new venues only.\n");
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

const WAVE_1 = ["antones-nightclub", "moody-amphitheater-austin", "the-mohawk"];

const probeOnly = process.argv.includes("--probe-only");
const venueFilter = process.argv.find((a) => a.startsWith("--venue="))?.split("=")[1];
const slugs = venueFilter ? [venueFilter] : WAVE_1;

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
if (!site) throw new Error("HeyAustin site not found");

const { data: venues } = await supabase
	.from("venues")
	.select("id, slug, name, calendar_url")
	.eq("site_id", site.id)
	.in("slug", slugs);

console.log(`\n=== Wave 1 pilot start (${probeOnly ? "probe only" : "ingest"}) ===\n`);

for (const venue of venues ?? []) {
	const { data: sources } = await supabase
		.from("venue_event_sources")
		.select("id")
		.eq("venue_id", venue.id)
		.limit(1);

	const testRes = await fetch(`${WORKER}/test-source`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			calendarUrl: venue.calendar_url,
			venueName: venue.name,
			scrapeDaysAhead: 90,
		}),
	});
	const test = await testRes.json();
	const ready = test.ready && test.events_found > 0;
	console.log(`${ready ? "✓" : "○"} ${venue.name} (${venue.slug})`);
	console.log(`  events=${test.events_found ?? 0} platform=${test.detected_platform ?? test.error ?? "—"}`);

	if (!probeOnly && ready) {
		const ingestRes = await fetch(`${WORKER}/ingest`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ venueId: venue.id, sourceId: sources?.[0]?.id }),
		});
		const ingest = await ingestRes.json();
		console.log(`  → workflow ${ingest.instanceId ?? ingest.error}`);
	}
	console.log();
}

if (!probeOnly) {
	await new Promise((r) => setTimeout(r, 15000));
	const { count } = await supabase
		.from("ingested_events")
		.select("id", { count: "exact", head: true })
		.eq("review_status", "pending");
	console.log(`Pending in ingestion queue: ${count ?? 0}`);
}