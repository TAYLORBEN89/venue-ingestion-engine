/**
 * Scrape entire Saxon Pub TEC calendar (all pages) and restage pending.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const env = Object.fromEntries(
	readFileSync("./.dev.vars", "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const TZ = "America/Chicago";

function getOffsetMin(timeZone, at) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})
			.formatToParts(at)
			.filter((p) => p.type !== "literal")
			.map((p) => [p.type, p.value]),
	);
	let hour = Number(parts.hour);
	if (hour === 24) hour = 0;
	const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
	return (asUtc - at.getTime()) / 60000;
}
function localToUtc(local, timeZone = TZ) {
	const [datePart, timePart] = local.replace("T", " ").split(" ");
	const [y, m, d] = datePart.split("-").map(Number);
	const [hh, mm, ss = 0] = timePart.split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, Number(ss)));
	return new Date(guess.getTime() - getOffsetMin(timeZone, guess) * 60000).toISOString();
}
function stripHtml(v) {
	let t = String(v || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
	return t.replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

const startDate = new Date().toISOString().slice(0, 10);
// Pull everything published out at least a year
const endDate = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10);

const events = [];
let page = 1;
let totalPages = 1;
while (page <= 50) {
	const url = `https://thesaxonpub.com/wp-json/tribe/events/v1/events?per_page=50&page=${page}&start_date=${startDate}&end_date=${endDate}&status=publish`;
	const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 events-platform-tec" } });
	if (!res.ok) throw new Error(`HTTP ${res.status} page ${page}`);
	const j = await res.json();
	totalPages = j.total_pages ?? page;
	const batch = j.events ?? [];
	console.log(`page ${page}/${totalPages}: ${batch.length} (api total ${j.total})`);
	for (const row of batch) {
		const tz = row.timezone || TZ;
		const starts_at = localToUtc(row.start_date, tz);
		const ends_at = row.end_date ? localToUtc(row.end_date, tz) : null;
		const cost = stripHtml(row.cost || "");
		events.push({
			title: stripHtml(row.title),
			starts_at,
			ends_at,
			description: stripHtml(row.description || row.excerpt || "") || null,
			image_url: row.image?.url ?? null,
			source_url: row.url,
			source_event_id: String(row.id),
			raw_date_text: row.start_date,
			price_text: cost
				? cost.toLowerCase() === "free"
					? "Free"
					: cost.startsWith("$")
						? cost
						: `$${cost}`
				: null,
			ticket_url: row.website || row.url,
		});
	}
	if (page >= totalPages || batch.length === 0) break;
	page++;
}

// de-dupe by tribe id
const seen = new Set();
const uniq = [];
for (const e of events) {
	if (seen.has(e.source_event_id)) continue;
	seen.add(e.source_event_id);
	uniq.push(e);
}
uniq.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(
	`\nParsed ${uniq.length} unique events`,
	uniq[0]?.raw_date_text,
	"→",
	uniq[uniq.length - 1]?.raw_date_text,
);

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.update({ calendar_url: "https://thesaxonpub.com/events/" })
	.eq("site_id", site.id)
	.eq("slug", "the-saxon-pub")
	.select("id, name")
	.single();

await sb
	.from("venue_event_sources")
	.update({
		platform_type: "tec",
		feed_url: "https://thesaxonpub.com/events/",
		calendar_url: "https://thesaxonpub.com/events/",
		scrape_days_ahead: 400,
		updated_at: new Date().toISOString(),
	})
	.eq("venue_id", venue.id);

const { count: rejected } = await sb
	.from("ingested_events")
	.update({ review_status: "rejected", reviewed_at: new Date().toISOString() })
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.select("id", { count: "exact", head: true });
console.log("rejected prior pending", rejected);

const { data: run } = await sb
	.from("ingestion_runs")
	.insert({
		site_id: site.id,
		venue_id: venue.id,
		status: "success",
		finished_at: new Date().toISOString(),
	})
	.select("id")
	.single();

const rows = uniq.map((e) => ({
	ingestion_run_id: run.id,
	venue_id: venue.id,
	raw_title: e.title,
	raw_date_text: e.raw_date_text,
	parsed_starts_at: e.starts_at,
	parsed_ends_at: e.ends_at,
	source_url: e.source_url,
	source_event_id: e.source_event_id,
	fingerprint: createHash("sha1")
		.update(`${e.title}|${e.starts_at}|${e.ticket_url}`)
		.digest("hex")
		.slice(0, 32),
	source_partner: "tec",
	extracted_band_name: e.title,
	matched_artist_id: null,
	artist_match_status: "unmatched",
	match_status: "new",
	matched_event_id: null,
	review_status: "pending",
	raw_payload: {
		description: e.description,
		price_text: e.price_text,
		ticket_url: e.ticket_url,
		image_url: e.image_url,
		confidence: 0.95,
		import_method: "feed",
		platform: "tec",
	},
}));

for (let i = 0; i < rows.length; i += 50) {
	const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 50));
	if (error) throw new Error(error.message);
}

const firstLocal = new Date(uniq[0].starts_at).toLocaleString("en-US", {
	timeZone: TZ,
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
const lastLocal = new Date(uniq[uniq.length - 1].starts_at).toLocaleString("en-US", {
	timeZone: TZ,
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
const withImg = rows.filter((r) => r.raw_payload.image_url).length;
const withDesc = rows.filter((r) => r.raw_payload.description).length;

console.log(`\nStaged ${rows.length} Saxon events`);
console.log(`Range (Chicago): ${firstLocal} → ${lastLocal}`);
console.log(`Images ${withImg} | Descriptions ${withDesc}`);
console.log("Queue: https://events-platform-admin.ben-745.workers.dev/ingestion?venue=saxon");
