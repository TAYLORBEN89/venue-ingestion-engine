/**
 * Moontower Saloon pilot — SpotApps events-holder
 *
 * Calendar: https://moontowersaloon.com/austin-menchaca-moontower-saloon-events
 * Free shows, no per-event URLs.
 *
 * Usage: node scripts/pilot-moontower.mjs [--probe-only]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const SLUG = "moontower-saloon";
const CALENDAR = "https://moontowersaloon.com/austin-menchaca-moontower-saloon-events";
const WEBSITE = "https://moontowersaloon.com/";
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

console.log("\n=== Moontower Saloon pilot (SpotApps) ===\n");

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) {
	console.error("Venue not found:", SLUG, vErr?.message ?? "");
	process.exit(1);
}
console.log("Venue:", venue.name, venue.id);

// Reject junk pending (ai_scrape date-titles, etc.)
const { data: junk } = await sb
	.from("ingested_events")
	.select("id, raw_title, source_partner")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.or("source_partner.eq.ai_scrape,source_partner.eq.html_calendar");
if (junk?.length) {
	const now = new Date().toISOString();
	await sb
		.from("ingested_events")
		.update({ review_status: "rejected", reviewed_at: now })
		.in(
			"id",
			junk.map((j) => j.id),
		);
	console.log(
		"Rejected junk pending:",
		junk.length,
		junk.slice(0, 5).map((j) => j.raw_title),
	);
}

await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR,
		website_url: venue.website_url || WEBSITE,
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
	platform_type: "spotapps",
	calendar_url: CALENDAR,
	feed_url: CALENDAR,
	publish_mode: "draft",
	is_enabled: true,
	scrape_days_ahead: 90,
	timezone: "America/Chicago",
	updated_at: new Date().toISOString(),
};

if (sourceId) {
	const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
	if (error) {
		const { error: e2 } = await sb
			.from("venue_event_sources")
			.update({ ...sourcePayload, platform_type: "auto" })
			.eq("id", sourceId);
		if (e2) throw new Error(`source update: ${error.message}; fallback: ${e2.message}`);
		console.log("Updated source", sourceId, "→ auto (spotapps constraint missing)");
	} else {
		console.log("Updated source", sourceId, "→ spotapps / draft / 90d");
	}
} else {
	const { data: ins, error } = await sb
		.from("venue_event_sources")
		.insert({ venue_id: venue.id, ...sourcePayload })
		.select("id")
		.single();
	if (error) {
		const { data: ins2, error: e2 } = await sb
			.from("venue_event_sources")
			.insert({ venue_id: venue.id, ...sourcePayload, platform_type: "auto" })
			.select("id")
			.single();
		if (e2) throw new Error(e2.message);
		sourceId = ins2.id;
		console.log("Created source", sourceId, "(auto)");
	} else {
		sourceId = ins.id;
		console.log("Created source", sourceId);
	}
}

console.log("\n--- test-source ---");
const testRes = await fetch(`${WORKER}/test-source`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: CALENDAR,
		venueName: venue.name,
		scrapeDaysAhead: 90,
		platformType: "spotapps",
		timezone: "America/Chicago",
	}),
});
const testText = await testRes.text();
let test;
try {
	test = JSON.parse(testText);
} catch {
	console.error("test-source non-JSON", testRes.status, testText.slice(0, 500));
	process.exit(1);
}
console.log(
	JSON.stringify(
		{
			status: testRes.status,
			ready: test.ready,
			events_found: test.events_found,
			detected_platform: test.detected_platform,
			has_images: test.has_images,
			has_ticket_links: test.has_ticket_links,
			messages: test.messages,
			sample_titles: test.sample_titles,
		},
		null,
		2,
	),
);

if (probeOnly) {
	process.exit(test.ready && (test.events_found ?? 0) > 0 ? 0 : 1);
}
if (!test.ready || !(test.events_found > 0)) {
	console.error("Source not ready — abort ingest");
	process.exit(1);
}

const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending before:", before ?? 0);

console.log("\n--- ingest (draft) ---");
const ingestRes = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ venueId: venue.id, sourceId }),
});
const ingest = await ingestRes.json();
console.log(ingest);
const instanceId = ingest.instanceId ?? ingest.id;
if (!instanceId) process.exit(1);

console.log("\n--- poll workflow ---");
for (let i = 0; i < 60; i++) {
	await new Promise((r) => setTimeout(r, 5000));
	const st = await (await fetch(`${WORKER}/ingest/${instanceId}`)).json();
	const statusVal =
		typeof st.status === "string" ? st.status : st.status?.status ?? st.state;
	console.log(`  [${i + 1}]`, statusVal);
	if (/complete|success|fail|error|terminated/i.test(String(statusVal))) {
		console.log("final", JSON.stringify(st).slice(0, 900));
		break;
	}
}

const { data: recent } = await sb
	.from("ingested_events")
	.select("id, raw_title, parsed_starts_at, review_status, source_partner, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.order("parsed_starts_at", { ascending: true });

console.log("\nPending after:", recent?.length ?? 0);
for (const r of recent ?? []) {
	const p = r.raw_payload || {};
	console.log(
		" -",
		r.parsed_starts_at?.slice(0, 19),
		"|",
		r.raw_title,
		"| img",
		!!p.image_url,
		"desc",
		(p.description || "").length,
		"| free",
		p.price_text,
		"| tix",
		p.ticket_url,
	);
}
console.log("\n=== Moontower pilot done ===");
