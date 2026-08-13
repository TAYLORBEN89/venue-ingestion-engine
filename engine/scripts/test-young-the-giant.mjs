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

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const url = "https://moodyamphitheater.com/events/young-the-giant";

const res = await fetch(url, { headers: { "User-Agent": UA } });
const html = await res.text();

const og =
	html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
	html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];

const ticketm = [
	...new Set([...html.matchAll(/https?:\/\/s\d\.ticketm\.net\/[^"'\s<>]+/gi)].map((m) => m[0])),
];
const ticketUrl = html.match(/href=["'](https:\/\/www\.ticketmaster\.com\/event\/[^"']+)["']/i)?.[1];
const iframes = [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0]).filter((b) => /youtube/i.test(b));

console.log("=== Live page: /events/young-the-giant ===");
console.log(`HTTP ${res.status} | HTML ${html.length} bytes\n`);
console.log("og:image (what we ingest):");
console.log(og ?? "(none)\n");
console.log(`ticketm.net in static HTML: ${ticketm.length}`);
for (const u of ticketm) console.log(`  ${u}`);
console.log(`\nticketmaster: ${ticketUrl ?? "(none)"}`);
console.log(`youtube iframes: ${iframes.length}`);
if (iframes[0]) console.log(iframes[0].replace(/\s+/g, " ").slice(0, 180));

const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";
const workerRes = await fetch(`${WORKER}/test-source`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: "https://moodyamphitheater.com/events-tickets",
		venueName: "Moody Amphitheater",
		scrapeDaysAhead: 90,
	}),
});
const workerData = await workerRes.json();
console.log("\n=== Worker test-source ===");
console.log(`events_found: ${workerData.events_found} | has_images: ${workerData.has_images}`);
console.log(`first sample: ${workerData.sample_titles?.[0] ?? "(none)"}`);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: venue } = await supabase.from("venues").select("id").eq("slug", "moody-amphitheater-austin").single();
const { data: rows } = await supabase
	.from("ingested_events")
	.select("id, raw_title, source_event_id, raw_payload, review_status, parsed_starts_at")
	.eq("venue_id", venue.id)
	.or("source_event_id.eq.young-the-giant,raw_title.ilike.%Young%Giant%");

console.log("\n=== DB ingested_events ===");
for (const row of rows ?? []) {
	const p = row.raw_payload ?? {};
	console.log(`\n[${row.review_status}] ${row.raw_title}`);
	console.log(`slug: ${row.source_event_id}`);
	console.log(`starts: ${row.parsed_starts_at}`);
	console.log("image_url:");
	console.log(p.image_url ?? "(none)");
	console.log(`youtube: ${p.youtube_embed ? "yes" : "no"}`);
	console.log(`ticket_url: ${p.ticket_url ?? "(none)"}`);
}