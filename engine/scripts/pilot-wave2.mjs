/**
 * Probe Wave 2 pilot venues + detect platform patterns.
 * Usage: node scripts/pilot-wave2.mjs [--ingest=slug]
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

const WAVE_2 = [
	{ slug: "the-moody-center", why: "Arena, high volume" },
	{ slug: "stubbs-bar-b-q", why: "403 fetch — needs browser-first" },
	{ slug: "the-mohawk", why: "Indie calendar" },
	{ slug: "moody-amphitheater-austin", why: "Webflow tickets page" },
	{ slug: "hotel-vegas", why: "East side WP" },
	{ slug: "cap-city-comedy-club", why: "Comedy, SeatEngine-style" },
	{ slug: "the-velveeta-room", why: "SeatEngine calendar URL in seed" },
	{ slug: "meanwhile-brewing-company", why: "Brewery /events page" },
	{ slug: "antones-nightclub", why: "Wave 1 baseline (event_discovery)" },
	{ slug: "continental-club", why: "Legendary club" },
	{ slug: "emo-s", why: "Emo's Austin" },
	{ slug: "acl-live-at-the-moody-theater", why: "ACL Live" },
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
	let data;
	try {
		data = await res.json();
	} catch {
		data = { error: await res.text() };
	}
	return { ok: res.ok, data };
}

const ingestSlug = process.argv.find((a) => a.startsWith("--ingest="))?.split("=")[1];
const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();

const slugs = WAVE_2.map((v) => v.slug);
let { data: venues } = await supabase
	.from("venues")
	.select("id, slug, name, calendar_url, address")
	.eq("site_id", site.id)
	.in("slug", slugs);

const found = new Set((venues ?? []).map((v) => v.slug));
for (const pilot of WAVE_2) {
	if (found.has(pilot.slug)) continue;
	const { data: fuzzy } = await supabase
		.from("venues")
		.select("id, slug, name, calendar_url, address")
		.eq("site_id", site.id)
		.or(`slug.ilike.%${pilot.slug.replace(/-/g, "%")}%,name.ilike.%${pilot.slug.split("-")[0]}%`)
		.not("calendar_url", "is", null)
		.limit(1);
	if (fuzzy?.[0]) venues = [...(venues ?? []), fuzzy[0]];
}

const bySlug = new Map((venues ?? []).map((v) => [v.slug, v]));

const results = [];
console.log("\n=== Wave 2 pilot probe ===\n");

for (const pilot of WAVE_2) {
	const venue = bySlug.get(pilot.slug) ?? [...bySlug.values()].find((v) => v.slug.includes(pilot.slug.split("-")[0]));
	if (!venue?.calendar_url) {
		console.log(`○ MISSING ${pilot.slug}`);
		results.push({ slug: pilot.slug, status: "missing" });
		continue;
	}

	const { ok, data } = await testSource(venue);
	const ready = ok && data?.ready;
	const row = {
		slug: venue.slug,
		name: venue.name,
		platform: data?.detected_platform ?? data?.error ?? "—",
		events: data?.events_found ?? 0,
		ready,
		noAi: data?.detected_platform === "event_discovery" || data?.messages?.some((m) => m.includes("iCal") || m.includes("Event Discovery")),
	};
	results.push(row);

	console.log(`${ready ? "✓" : "○"} ${venue.name} (${venue.slug})`);
	console.log(`  ${pilot.why}`);
	console.log(`  ${ready ? "READY" : "NOT READY"} | ${row.platform} | events=${row.events}`);
	if (data?.messages?.[0]) console.log(`  ${data.messages[0]}`);
	if (data?.sample_titles?.[0]) console.log(`  sample: ${data.sample_titles[0]}`);

	if (ingestSlug && (ingestSlug === pilot.slug || ingestSlug === venue.slug) && ready) {
		const { data: sources } = await supabase.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
		const ingest = await fetch(`${WORKER}/ingest`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ venueId: venue.id, sourceId: sources?.[0]?.id }),
		});
		console.log(`  → ingest: ${await ingest.text()}`);
	}
	console.log();
}

const ready = results.filter((r) => r.ready);
const noAi = results.filter((r) => r.noAi && r.ready);
console.log("--- Summary ---");
console.log(`Probed: ${results.length} | Ready: ${ready.length} | No-AI ready: ${noAi.length}`);
console.log("Ready:", ready.map((r) => r.slug).join(", ") || "none");