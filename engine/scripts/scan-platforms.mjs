/**
 * Scan HeyAustin venues with calendar_url for platform signals (sample).
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

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venues } = await supabase
	.from("venues")
	.select("slug, name, calendar_url")
	.eq("site_id", site.id)
	.not("calendar_url", "is", null)
	.order("name")
	.limit(40);

const buckets = new Map();
let probed = 0;

for (const venue of venues ?? []) {
	if (probed >= 15) break;
	try {
		const res = await fetch(`${WORKER}/test-source`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				calendarUrl: venue.calendar_url,
				venueName: venue.name,
				scrapeDaysAhead: 90,
			}),
		});
		const data = await res.json();
		const key = data.detected_platform ?? (data.error ? "error" : "unknown");
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key).push({
			slug: venue.slug,
			events: data.events_found ?? 0,
			ready: data.ready ?? false,
			msg: data.messages?.[0] ?? data.error ?? "",
		});
		probed++;
		await new Promise((r) => setTimeout(r, 400));
	} catch (e) {
		buckets.set("fetch_fail", [{ slug: venue.slug, msg: e.message }]);
	}
}

console.log(`\nPlatform scan (${probed} venues):\n`);
for (const [platform, rows] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
	const ready = rows.filter((r) => r.ready).length;
	console.log(`${platform}: ${rows.length} probed, ${ready} ready`);
	for (const r of rows.slice(0, 3)) {
		console.log(`  • ${r.slug} (${r.events ?? "?"} events) ${r.ready ? "✓" : "○"} ${r.msg?.slice(0, 60)}`);
	}
}