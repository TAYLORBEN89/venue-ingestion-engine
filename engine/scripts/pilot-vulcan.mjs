/**
 * Vulcan Gas Company pilot — Webflow homepage CMS list + TicketSauce.
 *
 *   node scripts/pilot-vulcan.mjs
 *   node scripts/pilot-vulcan.mjs --probe-only
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const SLUG = "vulcan-gas-company";
const CALENDAR = "https://www.vulcanatx.com/";
const WEBSITE = "https://www.vulcanatx.com/";
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
const SECRET = env.INGESTION_API_SECRET;
if (!SECRET) throw new Error("INGESTION_API_SECRET missing in .dev.vars");

function authHeaders(json = true) {
	const h = {
		authorization: `Bearer ${SECRET}`,
		"x-ingestion-secret": SECRET,
	};
	if (json) h["content-type"] = "application/json";
	return h;
}

console.log("\n=== Vulcan Gas Company pilot ===\n");

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
		website_url: WEBSITE,
		updated_at: new Date().toISOString(),
	})
	.eq("id", venue.id);

const { data: existing } = await sb
	.from("venue_event_sources")
	.select("id, platform_type, is_enabled")
	.eq("venue_id", venue.id);

let sourceId = existing?.[0]?.id;
// custom_html is allowed by DB check; vulcan_atx may not be until migration
const sourcePayload = {
	platform_type: "custom_html",
	calendar_url: CALENDAR,
	feed_url: CALENDAR,
	publish_mode: "draft",
	is_enabled: true,
	scrape_days_ahead: 120,
	timezone: "America/Chicago",
	updated_at: new Date().toISOString(),
	last_scrape_error: null,
};

if (sourceId) {
	const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
	if (error) throw new Error(`source update: ${error.message}`);
	console.log("Updated source", sourceId, "→ custom_html (Vulcan) / draft / 120d / enabled");
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
	headers: authHeaders(),
	body: JSON.stringify({
		calendarUrl: CALENDAR,
		venueName: venue.name,
		venueAddress: venue.address,
		platformType: "custom_html",
		scrapeDaysAhead: 120,
	}),
});
const testText = await testRes.text();
let test;
try {
	test = JSON.parse(testText);
} catch {
	console.error("test-source non-JSON", testRes.status, testText.slice(0, 400));
	process.exit(1);
}
console.log(
	JSON.stringify(
		{
			status: testRes.status,
			ready: test.ready,
			events_found: test.events_found,
			detected_platform: test.detected_platform,
			sample_titles: test.sample_titles,
			messages: test.messages,
			has_ticket_links: test.has_ticket_links,
			error: test.error,
		},
		null,
		2,
	),
);

if (probeOnly) {
	console.log("\n--probe-only: skip ingest");
	process.exit(test.ready && test.events_found > 0 ? 0 : 2);
}

if (!test.ready || !(test.events_found > 0)) {
	console.error("\nNot ready — fix parser / redeploy ingestion worker before ingest.");
	process.exit(2);
}

console.log("\n--- ingest ---");
const ingestRes = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: authHeaders(),
	body: JSON.stringify({ venueId: venue.id, sourceId }),
});
const ingestText = await ingestRes.text();
let ingest;
try {
	ingest = JSON.parse(ingestText);
} catch {
	console.error("ingest non-JSON", ingestRes.status, ingestText.slice(0, 400));
	process.exit(1);
}
console.log(ingest);

console.log("\nWaiting 45s for workflow…");
await new Promise((r) => setTimeout(r, 45_000));

const { count: pending } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("venue_id", venue.id)
	.eq("review_status", "pending");
console.log(`Pending for Vulcan: ${pending ?? 0}`);
console.log("Review: https://events-platform-admin.ben-745.workers.dev/ingestion");
console.log("Venue admin: /venues/" + venue.id);
