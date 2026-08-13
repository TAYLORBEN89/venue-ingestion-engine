/**
 * San Jac Saloon pilot — Google Calendar embeds on /events
 *
 * Venue:    https://www.sanjacsaloon.com/
 * Calendar: https://www.sanjacsaloon.com/events
 *
 * ─── Page walkthrough ───────────────────────────────────────────────────
 * Two iframes (month view; chevrons change months inside each embed):
 *   1) Downstairs / "SJS Shows"
 *      src=https://calendar.google.com/calendar/embed?src=sanjacsaloon%40gmail.com&ctz=America%2FChicago
 *   2) Upstairs / Jack's Room
 *      src=https://calendar.google.com/calendar/embed?src=mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com&ctz=America%2FChicago
 *
 * Inside embed UI (after chevron month nav):
 *   Day header:  <h2 class="CqwSk XuJrye">3 events, Sunday, June 28</h2>
 *   Event line:  <span class="XuJrye">1:30pm to 4:30pm, Bron Burbank, Calendar: SJS Shows, …</span>
 *                <span class="XuJrye">5pm to 8pm, Eric Bowden, Calendar: SJS Shows, …</span>
 *
 * ─── Scrape path (accurate multi-band days) ─────────────────────────────
 * Do NOT rely on public basic.ics alone — it is incomplete.
 * Example Fri Jul 17, 2026 (first calendar):
 *   UI / htmlembed: 3pm Aaron Navarro Duo · 6:30pm Ben Cina · 10pm Aaron Navarro Band
 *   basic.ics: only Ben Cina
 *
 * Use classic Google Calendar htmlembed agenda (static HTML):
 *   https://calendar.google.com/calendar/htmlembed?src=…&mode=AGENDA&dates=YYYYMMDD/YYYYMMDD
 *   Parser: scripts/lib/san-jac-htmlembed.mjs
 *   Smoke:  scripts/smoke-san-jac-htmlembed.mjs
 *
 * Horizon:
 *   Pilot (default): 1 month from today
 *   Build scrape:    current month through October (same year)  (--full)
 *
 * Prior misconfig: homepage AI scrape junk; squarespace_events on /shows; ICS-only scrape.
 *
 * Usage (from apps/ingestion):
 *   node scripts/pilot-san-jac.mjs --probe-only          # 1-month htmlembed smoke
 *   node scripts/pilot-san-jac.mjs --local-smoke --full  # 12-month full scrape + JSON
 *   node scripts/pilot-san-jac.mjs                       # configure sources + test-source
 *   node scripts/pilot-san-jac.mjs --ingest              # draft ingest (30d)
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const localSmoke = process.argv.includes("--local-smoke");
const doIngest = process.argv.includes("--ingest");
const FULL = process.argv.includes("--full");
/** Pilot window: 1 month from current date. Full scrape uses smoke --full. */
const SCRAPE_DAYS = FULL ? 400 : 30;

const SLUG = "san-jac-saloon";
const WEBSITE = "https://www.sanjacsaloon.com/";
/** Human-facing calendar page with both Google embeds + month chevrons */
const CALENDAR_PAGE = "https://www.sanjacsaloon.com/events";

const FEEDS = [
	{
		key: "downstairs",
		label: "Downstairs live music (SJS Shows)",
		ics: "https://calendar.google.com/calendar/ical/sanjacsaloon%40gmail.com/public/basic.ics",
		embed:
			"https://calendar.google.com/calendar/embed?src=sanjacsaloon%40gmail.com&ctz=America%2FChicago",
	},
	{
		key: "upstairs",
		label: "Upstairs / Jack's Room",
		ics: "https://calendar.google.com/calendar/ical/mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com/public/basic.ics",
		embed:
			"https://calendar.google.com/calendar/embed?src=mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com&ctz=America%2FChicago",
	},
];

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

console.log("\n=== San Jac Saloon pilot (Google Calendar /events) ===\n");
console.log("Calendar page:", CALENDAR_PAGE);
console.log("Feeds:", FEEDS.map((f) => f.key).join(", "));

// --- local smoke / full scrape via htmlembed (accurate multi-band) ---
if (localSmoke || probeOnly || FULL) {
	console.log(
		FULL
			? "\n--- full calendar scrape (htmlembed, no worker) ---\n"
			: "\n--- local smoke (htmlembed, pilot 1 month, no worker) ---\n",
	);
	const smokeArgs = [resolve(__dirname, "smoke-san-jac-htmlembed.mjs")];
	// --full = through October of the current year (not 12 months)
	if (FULL) smokeArgs.push("--full");
	else smokeArgs.push("--months=1");
	const r = spawnSync(process.execPath, smokeArgs, {
		stdio: "inherit",
		cwd: resolve(__dirname),
	});
	if ((probeOnly || FULL) && !doIngest) {
		process.exit(r.status ?? 1);
	}
	if ((r.status ?? 1) !== 0 && !doIngest) {
		console.error("Local smoke failed — abort before DB/source changes");
		process.exit(1);
	}
}

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address, status, event_feed_url, event_feed_type")
	.eq("slug", SLUG)
	.maybeSingle();

if (vErr || !venue) {
	console.error("Venue not found:", SLUG, vErr?.message ?? "");
	process.exit(1);
}
console.log("\nVenue:", venue.name, venue.id, "status=", venue.status);
console.log("  old calendar_url:", venue.calendar_url);
console.log("  old event_feed_url:", venue.event_feed_url);

// Reject junk pending (homepage AI scrape)
const { data: junk } = await sb
	.from("ingested_events")
	.select("id, raw_title, source_partner, source_url")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending");

const junkIds = (junk ?? [])
	.filter((j) => {
		const title = (j.raw_title || "").toLowerCase();
		const url = (j.source_url || "").toLowerCase();
		const partner = j.source_partner || "";
		if (partner === "ai_scrape" && !url.includes("calendar.google.com") && !url.includes(".ics")) {
			return true;
		}
		if (
			/\b(hours|happy hour|speciality cocktails|specialty cocktails|watch party|live country music daily)\b/i.test(
				title,
			)
		) {
			return true;
		}
		return false;
	})
	.map((j) => j.id);

if (junkIds.length) {
	const now = new Date().toISOString();
	await sb
		.from("ingested_events")
		.update({ review_status: "rejected", reviewed_at: now })
		.in("id", junkIds);
	console.log("Rejected junk pending:", junkIds.length);
	for (const j of junk ?? []) {
		if (junkIds.includes(j.id)) console.log("  -", j.raw_title);
	}
} else {
	console.log("No junk pending to reject");
}

// Point venue at /events + primary ICS (downstairs)
await sb
	.from("venues")
	.update({
		calendar_url: CALENDAR_PAGE,
		website_url: venue.website_url || WEBSITE,
		event_feed_url: FEEDS[0].ics,
		event_feed_type: "google_calendar",
		updated_at: new Date().toISOString(),
	})
	.eq("id", venue.id);
console.log("Updated venue calendar_url →", CALENDAR_PAGE);
console.log("Updated venue event_feed_url → downstairs ICS");

// Load all sources for this venue
const { data: existingSources } = await sb
	.from("venue_event_sources")
	.select("id, platform_type, calendar_url, feed_url, is_enabled")
	.eq("venue_id", venue.id);

const sourceIds = [];
for (const feed of FEEDS) {
	const match =
		(existingSources || []).find(
			(s) =>
				(s.feed_url && s.feed_url.includes(feed.ics.split("/ical/")[1]?.slice(0, 20))) ||
				(s.calendar_url && s.calendar_url === feed.ics) ||
				(s.feed_url && s.feed_url === feed.ics),
		) ||
		// first empty/old source slot for downstairs only
		(feed.key === "downstairs" ? existingSources?.[0] : null);

	const sourcePayload = {
		platform_type: "ical",
		calendar_url: CALENDAR_PAGE,
		feed_url: feed.ics,
		publish_mode: "draft",
		is_enabled: true,
		scrape_days_ahead: SCRAPE_DAYS,
		timezone: "America/Chicago",
		updated_at: new Date().toISOString(),
	};

	let sourceId = match?.id;
	if (sourceId) {
		const { error } = await sb.from("venue_event_sources").update(sourcePayload).eq("id", sourceId);
		if (error) {
			// platform_type enum may not include ical on older DBs — try google_calendar then auto
			const { error: e2 } = await sb
				.from("venue_event_sources")
				.update({ ...sourcePayload, platform_type: "google_calendar" })
				.eq("id", sourceId);
			if (e2) {
				const { error: e3 } = await sb
					.from("venue_event_sources")
					.update({ ...sourcePayload, platform_type: "auto" })
					.eq("id", sourceId);
				if (e3) throw new Error(`source update ${feed.key}: ${error.message}; ${e2.message}; ${e3.message}`);
				console.log("Updated source", sourceId, feed.key, `→ auto / draft / ${SCRAPE_DAYS}d (feed=ICS)`);
			} else {
				console.log(
					"Updated source",
					sourceId,
					feed.key,
					`→ google_calendar / draft / ${SCRAPE_DAYS}d`,
				);
			}
		} else {
			console.log("Updated source", sourceId, feed.key, `→ ical / draft / ${SCRAPE_DAYS}d`);
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
				.insert({ venue_id: venue.id, ...sourcePayload, platform_type: "google_calendar" })
				.select("id")
				.single();
			if (e2) {
				const { data: ins3, error: e3 } = await sb
					.from("venue_event_sources")
					.insert({ venue_id: venue.id, ...sourcePayload, platform_type: "auto" })
					.select("id")
					.single();
				if (e3) throw new Error(`source insert ${feed.key}: ${error.message}; ${e2.message}; ${e3.message}`);
				sourceId = ins3.id;
				console.log("Created source", sourceId, feed.key, "(auto)");
			} else {
				sourceId = ins2.id;
				console.log("Created source", sourceId, feed.key, "(google_calendar)");
			}
		} else {
			sourceId = ins.id;
			console.log("Created source", sourceId, feed.key, "(ical)");
		}
	}
	sourceIds.push({ key: feed.key, id: sourceId, ics: feed.ics });
}

// Disable leftover sources that are not our ICS feeds (old squarespace / homepage scrape)
const keepIds = new Set(sourceIds.map((s) => s.id));
const extras = (existingSources || []).filter((s) => !keepIds.has(s.id) && s.is_enabled);
if (extras.length) {
	await sb
		.from("venue_event_sources")
		.update({ is_enabled: false, updated_at: new Date().toISOString() })
		.in(
			"id",
			extras.map((s) => s.id),
		);
	console.log("Disabled leftover sources:", extras.length);
}

// test-source each ICS via worker
console.log("\n--- test-source (worker) ---");
let anyReady = false;
for (const src of sourceIds) {
	console.log(`\n[${src.key}]`, src.ics);
	try {
		const testRes = await fetch(`${WORKER}/test-source`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(env.INGESTION_ADMIN_TOKEN
					? { Authorization: `Bearer ${env.INGESTION_ADMIN_TOKEN}` }
					: {}),
			},
			body: JSON.stringify({
				calendarUrl: src.ics,
				venueName: venue.name,
				scrapeDaysAhead: SCRAPE_DAYS,
				platformType: "ical",
				timezone: "America/Chicago",
				venueId: venue.id,
			}),
		});
		const testText = await testRes.text();
		let test;
		try {
			test = JSON.parse(testText);
		} catch {
			console.error("test-source non-JSON", testRes.status, testText.slice(0, 400));
			continue;
		}
		console.log(
			JSON.stringify(
				{
					status: testRes.status,
					ready: test.ready,
					events_found: test.events_found,
					detected_platform: test.detected_platform,
					platform_label: test.platform_label,
					sample_titles: test.sample_titles,
					messages: test.messages,
					error: test.error,
				},
				null,
				2,
			),
		);
		await sb
			.from("venue_event_sources")
			.update({
				last_test_at: new Date().toISOString(),
				last_test_result: test,
				updated_at: new Date().toISOString(),
			})
			.eq("id", src.id);
		if (test.ready && (test.events_found ?? 0) > 0) anyReady = true;
	} catch (e) {
		console.warn("test-source failed:", e.message);
	}
}

if (!doIngest) {
	console.log("\nConfigured. Pass --ingest to enqueue draft ingestion.");
	console.log("Review pending at admin /ingestion (publish_mode=draft — never auto-approve).");
	process.exit(anyReady || localSmoke || probeOnly ? 0 : 1);
}

if (!anyReady) {
	console.error("\nNo feed reported ready with events — abort ingest.");
	console.error("Local ICS smoke may still work; redeploy ingestion worker if test-source fails.");
	process.exit(1);
}

const { count: before } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);
console.log("\nPending for San Jac before:", before ?? 0);

// Ingest each source
for (const src of sourceIds) {
	console.log(`\n--- ingest draft [${src.key}] ---`);
	const ingestRes = await fetch(`${WORKER}/ingest`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(env.INGESTION_ADMIN_TOKEN ? { Authorization: `Bearer ${env.INGESTION_ADMIN_TOKEN}` } : {}),
		},
		body: JSON.stringify({ venueId: venue.id, sourceId: src.id }),
	});
	const ingestText = await ingestRes.text();
	let ingest;
	try {
		ingest = JSON.parse(ingestText);
	} catch {
		console.error("ingest non-JSON", ingestRes.status, ingestText.slice(0, 400));
		continue;
	}
	console.log(ingest);
	const instanceId = ingest.instanceId ?? ingest.id;
	if (!instanceId) {
		console.warn("No workflow instance id for", src.key);
		continue;
	}
	console.log("poll", instanceId);
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 4000));
		const stRes = await fetch(`${WORKER}/ingest/${instanceId}`);
		const st = await stRes.json();
		const statusVal =
			typeof st.status === "string"
				? st.status
				: st.status?.status ?? st.state ?? JSON.stringify(st).slice(0, 100);
		console.log(`  [${i + 1}]`, statusVal);
		if (/complete|success|fail|error|terminated/i.test(String(statusVal))) {
			console.log("final", JSON.stringify(st).slice(0, 600));
			break;
		}
	}
}

const { count: after } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending")
	.eq("venue_id", venue.id);

const { data: recent } = await sb
	.from("ingested_events")
	.select("id, raw_title, parsed_starts_at, review_status, match_status, source_url")
	.eq("venue_id", venue.id)
	.order("created_at", { ascending: false })
	.limit(30);

console.log("\nPending for San Jac after:", after ?? 0);
console.log("Recent ingested_events:");
for (const r of recent ?? []) {
	console.log(
		" -",
		r.review_status,
		r.match_status,
		r.parsed_starts_at,
		"|",
		r.raw_title?.slice(0, 55),
	);
}
console.log("\nReview at admin /ingestion (draft only — approve carefully).");
console.log("Next: match researched artists + bulk-publish pending for slug san-jac-saloon.");
