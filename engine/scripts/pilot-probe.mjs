/**
 * Probe pilot venues against live ingestion worker.
 * Usage: node scripts/pilot-probe.mjs [--ingest=venue-slug]
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

const PILOT_WAVE_1 = [
	{ slug: "antones-nightclub", why: "Blues club, Event Discovery API (no AI)" },
	{ slug: "hotel-vegas", why: "East Austin anchor, homepage calendar" },
	{ slug: "stubbs-bar-b-q", why: "Event Discovery API (same plugin as Antone's)" },
	{ slug: "the-mohawk", why: "Prekindle API (no AI)" },
	{ slug: "moody-amphitheater-austin", why: "Webflow events-tickets page" },

];

async function testSource(venue) {
	const res = await fetch(`${WORKER}/test-source`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			calendarUrl: venue.calendar_url,
			venueName: venue.name,
			venueAddress: venue.address,
			scrapeDaysAhead: 90,
		}),
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { error: text, status: res.status };
	}
	return { ok: res.ok, data };
}

const ingestSlug = process.argv.find((a) => a.startsWith("--ingest="))?.split("=")[1];

const { data: site } = await supabase.from("sites").select("id, slug, name").eq("slug", "heyaustin").single();
if (!site) throw new Error("HeyAustin site not found");

const { count: artistCount } = await supabase.from("artists").select("id", { count: "exact", head: true }).eq("site_id", site.id);
const { count: pendingCount } = await supabase.from("ingested_events").select("id", { count: "exact", head: true }).eq("review_status", "pending");

console.log(`\n=== HeyAustin pilot probe ===`);
console.log(`Artists in catalog: ${artistCount ?? 0}`);
console.log(`Pending in ingestion queue: ${pendingCount ?? 0}\n`);

const slugs = PILOT_WAVE_1.map((p) => p.slug);
const { data: venues } = await supabase
	.from("venues")
	.select("id, slug, name, calendar_url, address")
	.eq("site_id", site.id)
	.in("slug", slugs);

const bySlug = new Map((venues ?? []).map((v) => [v.slug, v]));

for (const pilot of PILOT_WAVE_1) {
	const venue = bySlug.get(pilot.slug);
	if (!venue?.calendar_url) {
		console.log(`MISSING ${pilot.slug} — add calendar_url in admin first`);
		console.log(`  (${pilot.why})\n`);
		continue;
	}

	const { data: sources } = await supabase.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
	const { ok, data } = await testSource(venue);
	const n = data?.events_found ?? "?";
	const ready = data?.ready ? "READY" : "NOT READY";

	console.log(`${ok && data?.ready ? "✓" : "○"} ${venue.name}`);
	console.log(`  ${pilot.why}`);
	console.log(`  ${ready} | platform=${data?.detected_platform ?? data?.error ?? "—"} | events=${n}`);
	if (data?.messages?.length) console.log(`  ${data.messages.join(" | ")}`);
	if (data?.sample_titles?.length) console.log(`  samples: ${data.sample_titles.slice(0, 3).join("; ")}`);

	if (ingestSlug === pilot.slug && venue.id) {
		const res = await fetch(`${WORKER}/ingest`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ venueId: venue.id, sourceId: sources?.[0]?.id }),
		});
		console.log(`  → ingest: ${await res.text()}`);
	}
	console.log();
}

console.log("Next: node scripts/pilot-probe.mjs --ingest=antones-nightclub");