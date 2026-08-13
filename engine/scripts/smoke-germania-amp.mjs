/**
 * Local smoke test for Germania Amp HTML parser (no worker deploy required).
 *   node scripts/smoke-germania-amp.mjs
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// Dynamic import of TS via tsx is heavy; reimplement minimal call through worker test-source after deploy.
// For pure parse, inline fetch + dynamic import of built logic via node --experimental-strip-types if available.

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LIST = "http://germaniaamp.com/events/";

const MONTHS = {
	jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
	may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
	september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function strip(s) {
	return String(s || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

const html = await (await fetch(LIST, { headers: { "user-agent": UA } })).text();
const section =
	html.match(
		/<div[^>]*class="[^"]*upcoming-shows[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*columns[^"]*past|<footer|Our Sponsors|$)/i,
	)?.[1] ?? html;

const parts = section.split(/(?=<div[^>]*class="[^"]*card events[^"]*")/i);
const cards = [];
for (const part of parts) {
	if (!/card events/i.test(part)) continue;
	const chunk = part.slice(0, 2200);
	const href = chunk.match(/href=["'](https?:\/\/[^"']*\/events\/[^"'#?]+)["']/i)?.[1];
	const title = strip(chunk.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1]);
	const dm = chunk.match(
		/<div[^>]*class="[^"]*media-left[^"]*"[^>]*>\s*<span>\s*(\d{1,2})\s*<\/span>\s*([A-Za-z]{3,9})\s*(?:<br\s*\/?>)?\s*<em>\s*(\d{4})\s*<\/em>/i,
	);
	const img = chunk.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
	if (!href || !title || !dm) continue;
	const mon = MONTHS[dm[2].toLowerCase()];
	const ymd = `${dm[3]}-${pad2(mon)}-${pad2(+dm[1])}`;
	const slug = href.replace(/\/$/, "").split("/").pop();
	cards.push({ title, ymd, href, img, slug });
}

console.log(`\nList cards: ${cards.length}\n`);
for (const c of cards) console.log(`  ${c.ymd}  ${c.title}  → ${c.slug}`);

// Enrich first 3 details
console.log("\n--- Detail enrich (first 3) ---\n");
for (const c of cards.slice(0, 3)) {
	const dhtml = await (await fetch(c.href, { headers: { "user-agent": UA } })).text();
	const sub = strip(
		dhtml.match(/<h2[^>]*class="[^"]*subtitle(?![^"]*alt)[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "",
	);
	const tm = dhtml.match(/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/event\/[^"'#?]+)/i)?.[1];
	const aboutIdx = dhtml.search(/About the Artist/i);
	const region = aboutIdx >= 0 ? dhtml.slice(aboutIdx, aboutIdx + 8000) : "";
	const artistNames = [
		...region.matchAll(/<div[^>]*class="[^"]*card artist[^"]*"[\s\S]*?<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi),
	].map((m) => strip(m[1]));
	const headshot = region.match(/src=["'](https?:\/\/[^"']*artist-images[^"']*)["']/i)?.[1];
	console.log(c.title);
	console.log("  when:", sub || c.ymd);
	console.log("  ticket:", tm || "(none)");
	console.log("  artists:", artistNames.join(" · ") || "(none)");
	console.log("  headshot:", headshot ? "yes" : "no");
	console.log("  poster:", c.img ? "yes" : "no");
	console.log();
}

// Ensure DB source URL
const env = Object.fromEntries(
	readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
		.split(/\r?\n/)
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: venue } = await sb
	.from("venues")
	.select("id")
	.eq("slug", "germania-insurance-amphitheater")
	.single();
if (venue) {
	await sb
		.from("venues")
		.update({ calendar_url: LIST, updated_at: new Date().toISOString() })
		.eq("id", venue.id);
	const { data: src } = await sb
		.from("venue_event_sources")
		.select("id")
		.eq("venue_id", venue.id)
		.limit(1);
	if (src?.[0]) {
		const { error } = await sb
			.from("venue_event_sources")
			.update({
				calendar_url: LIST,
				feed_url: LIST,
				platform_type: "custom_html", // detect via URL/HTML; DB may not allow germania_amp yet
				scrape_days_ahead: 200,
				publish_mode: "draft",
				is_enabled: true,
				timezone: "America/Chicago",
				updated_at: new Date().toISOString(),
			})
			.eq("id", src[0].id);
		console.log(error ? `source update error: ${error.message}` : "DB source → germaniaamp.com/events/");
	}
}

console.log("Done. Deploy ingestion worker, then:\n  node scripts/pilot-germania-amp.mjs\n");
