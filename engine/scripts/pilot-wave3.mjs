/**
 * Pilot Wave 3: probe + ingest venues not yet on partner_import events.
 * Usage: node scripts/pilot-wave3.mjs [--ingest]
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
const doIngest = process.argv.includes("--ingest");

const WAVE_3 = [
	"flamingo-cantina",
	"hotel-vegas",
	"stubbs-bar-b-q",
	"the-mohawk",
	"moody-amphitheater-austin",
	"antones-nightclub",
	"buck-s-backyard",
	"emo-s-austin",
	"elephant-room",
	"cactus-cafe",
	"mercer-dancehall",
	"sahara-lounge",
	"the-white-horse",
	"the-historic-scoot-inn",
	"empire-control-room",
	"long-center",
	"empire-control-room-and-garage",
	"germania-insurance-amphitheater",
];

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venues } = await supabase
	.from("venues")
	.select("id, slug, name, calendar_url, address")
	.eq("site_id", site.id)
	.in("slug", WAVE_3);

const bySlug = new Map((venues ?? []).map((v) => [v.slug, v]));
const ready = [];

console.log("\n=== Wave 3 pilot ===\n");

for (const slug of WAVE_3) {
	const venue = bySlug.get(slug);
	if (!venue?.calendar_url) {
		console.log(`○ MISSING ${slug}`);
		continue;
	}

	const [{ count: evCount }, { count: pending }] = await Promise.all([
		supabase
			.from("events")
			.select("id", { count: "exact", head: true })
			.eq("venue_id", venue.id)
			.in("source", ["partner_import", "ai_ingested"]),
		supabase
			.from("ingested_events")
			.select("id", { count: "exact", head: true })
			.eq("venue_id", venue.id)
			.eq("review_status", "pending"),
	]);

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
	const isReady = test.ready && test.events_found > 0;

	console.log(
		`${isReady ? "✓" : "○"} ${venue.name} (${slug}) | events_db=${evCount ?? 0} pending=${pending ?? 0} | probe=${test.events_found ?? 0} ${test.detected_platform ?? test.error ?? ""}`,
	);

	if (!isReady) continue;
	ready.push(venue);

	if (doIngest && isReady && ((evCount ?? 0) === 0 || (evCount ?? 0) < (test.events_found ?? 0))) {
		const { data: sources } = await supabase.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
		const ingestRes = await fetch(`${WORKER}/ingest`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ venueId: venue.id, sourceId: sources?.[0]?.id }),
		});
		const ingest = await ingestRes.json();
		console.log(`  → ${ingest.instanceId ?? ingest.error ?? JSON.stringify(ingest)}`);
		await new Promise((r) => setTimeout(r, 4000));
	}
}

console.log(`\nReady to pilot: ${ready.map((v) => v.slug).join(", ") || "none"}`);
if (!doIngest) console.log("Run with --ingest to queue workflows for venues with room to grow.");