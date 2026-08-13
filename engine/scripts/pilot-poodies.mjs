/**
 * Poodie's Hilltop Roadhouse — Outhouse Tickets venue grid pilot.
 *
 * Calendar: https://outhousetickets.com/venues/poodies-hilltop-roadhouse
 * Cards: grid → /events/{slug}/tickets, Cloudinary img, h3 title, date/time
 *
 *   node scripts/pilot-poodies.mjs --probe-only
 *   node scripts/pilot-poodies.mjs --ingest
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const doIngest = process.argv.includes("--ingest");
const SLUG = "poodie-s-hilltop-roadhouse";
/** Outhouse SPA venue path (organizer_slug) */
const CALENDAR = "https://outhousetickets.com/venues/poodies-hilltop-roadhouse";
const OUTHOUSE_ORGANIZER_SLUG = "poodies-hilltop-roadhouse";
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
const secret = (env.INGESTION_API_SECRET || process.env.INGESTION_API_SECRET || "").trim();
if (!secret) {
	console.error("Missing INGESTION_API_SECRET in apps/ingestion/.dev.vars");
	process.exit(1);
}
const authHeaders = {
	"content-type": "application/json",
	Authorization: `Bearer ${secret}`,
	"X-Ingestion-Secret": secret,
};

console.log("\n=== Poodie's Hilltop Roadhouse pilot (Outhouse Tickets) ===\n");

let { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();

if (vErr || !venue) {
	const { data: alt } = await sb
		.from("venues")
		.select("id, slug, name, calendar_url, website_url, address, status")
		.or("name.ilike.%poodie%,slug.ilike.%poodie%")
		.limit(10);
	console.error("Venue not found for slug", SLUG, vErr?.message ?? "");
	console.error("Candidates:", alt);
	process.exit(1);
}
console.log("Venue:", venue.name, venue.id, venue.slug);

await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR,
		website_url: venue.website_url || "https://poodies.net/",
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
	headers: authHeaders,
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
			has_ticket_links: test.has_ticket_links,
			sample_titles: test.sample_titles,
			messages: test.messages,
			error: test.error,
		},
		null,
		2,
	),
);
if (Array.isArray(test.events)) {
	for (const e of test.events.slice(0, 8)) {
		console.log(" -", e.starts_at ?? e.startsAt ?? "", "|", e.title);
	}
}

if (probeOnly) process.exit(test.ready && (test.events_found ?? 0) > 0 ? 0 : 1);

if (!doIngest) {
	console.log("\n(pass --ingest to enqueue)");
	process.exit(0);
}

if (!test.ready || !(test.events_found > 0)) {
	console.error("Not ready — check platform detect / Outhouse grid");
	process.exit(1);
}

const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending before:", before ?? 0);

console.log("\n--- ingest ---\n");
const ingestRes = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: authHeaders,
	body: JSON.stringify({ venueId: venue.id, sourceId }),
});
const ingestText = await ingestRes.text();
let ingest;
try {
	ingest = JSON.parse(ingestText);
} catch {
	ingest = { raw: ingestText };
}
console.log(ingestRes.status, ingest);
const instanceId = ingest.instanceId ?? ingest.id;
if (!instanceId) {
	console.error("No workflow instance id");
	process.exit(1);
}

console.log("\n--- poll workflow ---");
for (let i = 0; i < 60; i++) {
	await new Promise((r) => setTimeout(r, 5000));
	const stRes = await fetch(`${WORKER}/ingest/${instanceId}`, { headers: authHeaders });
	const st = await stRes.json();
	const status = st.status?.status ?? st.status ?? st.state;
	console.log("poll", i, status);
	if (status === "complete" || status === "errored" || status === "error" || status === "terminated") {
		console.log("output", JSON.stringify(st.status?.output ?? st.output ?? st, null, 2).slice(0, 2000));
		break;
	}
}

const { data: pending } = await sb
	.from("ingested_events")
	.select("raw_title, parsed_starts_at, source_partner, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.order("parsed_starts_at", { ascending: true });

console.log("\nPending now:", pending?.length ?? 0);
let withImg = 0;
let withTix = 0;
for (const e of pending || []) {
	if (e.raw_payload?.image_url) withImg++;
	if (e.raw_payload?.ticket_url) withTix++;
	console.log(
		" ",
		String(e.parsed_starts_at || "").slice(0, 16),
		"|",
		e.raw_title,
		e.raw_payload?.image_url ? "img" : "no-img",
		e.raw_payload?.ticket_url ? "tix" : "no-tix",
	);
}
console.log(`images ${withImg}/${pending?.length ?? 0}  tickets ${withTix}/${pending?.length ?? 0}`);
console.log("\nDone. Review pending for", venue.slug);
console.log("Admin → /ingestion (filter Poodie's)");
