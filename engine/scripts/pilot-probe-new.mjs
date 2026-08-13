/**
 * Probe ONLY never-piloted venues (no events, no ingested history, not on completed list).
 * Usage: node scripts/pilot-probe-new.mjs [--limit=20]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { loadNewPilotSources } from "./lib/pilot-venue-filters.mjs";
import { pilotSourcePriority } from "./lib/pilot-source-priority.mjs";

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
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 20);

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const sources = await loadNewPilotSources(supabase, site.id);

console.log(`\n=== New pilot candidates: ${sources.length} (probing up to ${limit}, music/structured feeds first) ===\n`);
if (sources[0]) {
	const top = sources.slice(0, 3).map((s) => `${s.venues.slug}(${pilotSourcePriority(s)})`);
	console.log(`Top priority: ${top.join(", ")}\n`);
}

const ready = [];
const blocked = [];

for (const source of sources.slice(0, limit)) {
	const venue = source.venues;
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
	const row = {
		slug: venue.slug,
		platform: test.detected_platform ?? test.error,
		events: test.events_found ?? 0,
		ready: Boolean(test.ready && test.events_found > 0),
		note: test.messages?.[0] ?? test.error ?? "",
	};

	if (row.ready) {
		ready.push(row);
		console.log(`✓ READY  ${venue.slug} | ${row.events} ${row.platform}`);
	} else {
		blocked.push(row);
		const kind = /429|rate limit/i.test(String(row.note))
			? "rate-limit"
			: row.platform === "custom_html"
				? "needs-parser"
				: /404|403|fetch/i.test(String(row.note))
					? "bad-url"
					: "not-ready";
		console.log(`○ ${kind.padEnd(12)} ${venue.slug} | ${row.events} ${row.platform}`);
		if (row.note) console.log(`           ${String(row.note).slice(0, 90)}`);
	}

	await new Promise((r) => setTimeout(r, 2500));
}

console.log("\n--- Summary ---");
console.log(`New venues in pool: ${sources.length}`);
console.log(`Ready to ingest: ${ready.length}`);
if (ready.length) console.log(ready.map((r) => r.slug).join(", "));
console.log(`Blocked: ${blocked.length}`);
const byKind = {};
for (const b of blocked) {
	const k = /429|rate limit/i.test(String(b.note))
		? "rate-limit"
		: b.platform === "custom_html"
			? "needs-parser"
			: /404|403/i.test(String(b.note))
				? "bad-url"
				: "other";
	byKind[k] = (byKind[k] ?? 0) + 1;
}
console.log("Blockers:", byKind);
console.log("\nIngest ready new venues:");
console.log("  node scripts/pilot-ingest-new.mjs --limit=5");