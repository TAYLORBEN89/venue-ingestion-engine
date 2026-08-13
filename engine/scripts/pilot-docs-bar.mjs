/**
 * Doc's Bar and Grill (Doc's Backyard) pilot — SpotApps pinboard/agenda calendar.
 *
 * Calendar: https://eatdrinkdocs.com/events
 * Layout: Agenda tab (#eventPinboardViewItem) + #pinboardAgendaContainer
 *         + #monthFilter=all + div.event-calendar-card
 *
 * Usage:
 *   node scripts/pilot-docs-bar.mjs --probe-only
 *   node scripts/pilot-docs-bar.mjs --local-smoke
 *   node scripts/pilot-docs-bar.mjs              # configure source + test-source
 *   node scripts/pilot-docs-bar.mjs --ingest     # configure + enqueue venue ingestion
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const localSmoke = process.argv.includes("--local-smoke");
const doIngest = process.argv.includes("--ingest");
const SLUG = "doc-s-bar-and-grill";
const CALENDAR = "https://eatdrinkdocs.com/events";
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

console.log("\n=== Doc's Bar and Grill pilot (SpotApps pinboard/agenda) ===\n");
console.log("Calendar:", CALENDAR);

if (localSmoke || probeOnly) {
	console.log("--- local smoke (parse HTML, no worker) ---\n");
	const r = spawnSync(process.execPath, [resolve(__dirname, "smoke-spotapps-docs.mjs")], {
		stdio: "inherit",
		cwd: resolve(__dirname, "../.."),
	});
	if (probeOnly || !doIngest) process.exit(r.status ?? 1);
}

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status")
	.eq("slug", SLUG)
	.maybeSingle();
if (vErr || !venue) {
	const { data: alt } = await sb
		.from("venues")
		.select("id, slug, name, calendar_url, website_url, address, status")
		.or("name.ilike.%doc%bar%,name.ilike.%doc%backyard%,slug.ilike.%doc%")
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
		website_url: venue.website_url || "https://eatdrinkdocs.com/",
		updated_at: new Date().toISOString(),
	})
	.eq("id", venue.id);
console.log("Set calendar_url →", CALENDAR);

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
	scrape_days_ahead: 200,
	timezone: "America/Chicago",
	updated_at: new Date().toISOString(),
};

if (sourceId) {
	const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
	if (error) {
		// Some DBs constrain platform_type enum — fall back to auto (detect still hits spotapps)
		const { error: e2 } = await sb
			.from("venue_event_sources")
			.update({ ...sourcePayload, platform_type: "auto" })
			.eq("id", sourceId);
		if (e2) throw new Error(`source update: ${error.message}; fallback: ${e2.message}`);
		console.log("Updated source", sourceId, "→ auto (spotapps rejected) / draft / 200d");
	} else {
		console.log("Updated source", sourceId, "→ spotapps / draft / 200d");
	}
} else {
	const { data: created, error } = await sb
		.from("venue_event_sources")
		.insert({
			venue_id: venue.id,
			...sourcePayload,
			created_at: new Date().toISOString(),
		})
		.select("id")
		.single();
	if (error) {
		const { data: created2, error: e2 } = await sb
			.from("venue_event_sources")
			.insert({
				venue_id: venue.id,
				...sourcePayload,
				platform_type: "auto",
				created_at: new Date().toISOString(),
			})
			.select("id")
			.single();
		if (e2) throw new Error(`source insert: ${error.message}; fallback: ${e2.message}`);
		sourceId = created2.id;
		console.log("Created source", sourceId, "→ auto / draft / 200d");
	} else {
		sourceId = created.id;
		console.log("Created source", sourceId, "→ spotapps / draft / 200d");
	}
}

// Remote test-source against worker (uses deployed parser — redeploy after code change)
console.log("\n--- test-source via worker ---\n");
try {
	const res = await fetch(`${WORKER}/test-source`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(env.INGESTION_ADMIN_TOKEN
				? { Authorization: `Bearer ${env.INGESTION_ADMIN_TOKEN}` }
				: {}),
		},
		body: JSON.stringify({
			calendarUrl: CALENDAR,
			platformType: "auto",
			scrapeDaysAhead: 200,
			venueName: venue.name,
			venueId: venue.id,
		}),
	});
	const body = await res.json();
	console.log(
		JSON.stringify(
			{
				status: res.status,
				ready: body.ready,
				events_found: body.events_found,
				detected_platform: body.detected_platform,
				has_images: body.has_images,
				sample_titles: body.sample_titles,
				messages: body.messages,
			},
			null,
			2,
		),
	);
} catch (e) {
	console.warn("test-source failed (worker may be offline / needs deploy):", e.message);
}

if (doIngest) {
	console.log("\n--- enqueue venue ingestion ---\n");
	const ingestRes = await fetch(`${WORKER}/ingest`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(env.INGESTION_ADMIN_TOKEN
				? { Authorization: `Bearer ${env.INGESTION_ADMIN_TOKEN}` }
				: {}),
		},
		body: JSON.stringify({ venueId: venue.id, sourceId }),
	});
	console.log("ingest", ingestRes.status, await ingestRes.text());
}

console.log("\nDone. Next: review pending in admin, then approve-pending for", SLUG);
console.log("  node scripts/approve-pending.mjs --venue=" + SLUG + " --confirm-bulk-approve");
