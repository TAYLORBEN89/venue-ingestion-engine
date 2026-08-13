/**
 * Stage Vulcan Gas Company events into pending review (bypasses CF workflow
 * artist-catalog 1MiB step limit).
 *
 * Uses live homepage + TicketSauce parsers (mirrors vulcan-atx.ts).
 *
 *   node scripts/pilot-vulcan-stage.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
	readFileSync(resolve(__dirname, "../.dev.vars"), "utf8")
		.split(/\r?\n/)
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const TZ = "America/Chicago";
const VENUE_ID = "aa9a5a4d-0708-4bde-ba0d-efd86eb9a5d3";
const SITE_ID = "51177cff-babf-4a36-a258-834f4e880b87";
const UA = "Mozilla/5.0 (compatible; HeyAustinBot/1.0)";

const MONTHS = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function decodeEntities(s) {
	return String(s || "")
		.replace(/&amp;/gi, "&")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#x27;|&#0?39;|&apos;/gi, "'")
		.replace(/&#8217;|&#8216;/g, "'")
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&quot;/gi, '"')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.trim();
}
function stripHtml(s) {
	return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}
function parseClock(text) {
	const m = String(text || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!m) return null;
	let hour = Number(m[1]) % 12;
	if (m[3].toLowerCase() === "pm") hour += 12;
	return `${String(hour).padStart(2, "0")}:${m[2]}:00`;
}
function getOffsetMin(at) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: TZ,
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
	return (
		(Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second) -
			at.getTime()) /
		60000
	);
}
function localToUtc(date, clock) {
	const [y, m, d] = date.split("-").map(Number);
	const [hh, mm, ss = 0] = clock.split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, +ss));
	return new Date(guess.getTime() - getOffsetMin(guess) * 60000).toISOString();
}
function ymd(y, m, d) {
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function fp(title, starts, ticket) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${ticket ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}
function key(title, starts) {
	return `${title.toLowerCase().replace(/\s+/g, " ").trim()}|${starts.slice(0, 16)}`;
}

async function get(url) {
	const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

function parseHome(html) {
	const yearNow = new Date().getFullYear();
	const out = [];
	for (const chunk of html.split(/role=["']listitem["']/i).slice(1)) {
		const title = stripHtml(chunk.match(/class=["']event-name["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		const monRaw = stripHtml(chunk.match(/class=["']event-month["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		const dayRaw = stripHtml(chunk.match(/class=["']event-date["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		const timeRaw = stripHtml(chunk.match(/class=["']event-time["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
		if (!title || !monRaw || !dayRaw) continue;
		const month = MONTHS[monRaw.toLowerCase().slice(0, 3)];
		const day = Number(dayRaw);
		if (!month || !day) continue;
		const clock = parseClock(timeRaw) || "20:00:00";
		const date = ymd(yearNow, month, day);
		const starts_at = localToUtc(date, clock);
		const ticket =
			chunk.match(
				/href=["'](https?:\/\/[^"']*(?:ticketsauce|dice\.fm|etix|eventim|loop1tickets|ticketmaster|axs)[^"']*)["']/i,
			)?.[1] ?? null;
		const ticket_url =
			ticket && !/^https?:\/\/(www\.)?vulcanatx\.com\/?$/i.test(ticket) ? decodeEntities(ticket) : null;
		out.push({
			title,
			starts_at,
			ends_at: null,
			ticket_url,
			source_url: ticket_url || "https://www.vulcanatx.com/",
			source_event_id: `vulcan-home|${title}|${date}|${clock}`,
			raw_date_text: `${monRaw} ${day} · ${timeRaw}`,
			image_url: null,
		});
	}
	return out;
}

function parseTs(html) {
	const out = [];
	const re =
		/href=["'](https:\/\/vulcanatx\.ticketsauce\.com\/e\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<div[^>]*>([\s\S]*?)<\/div>/gi;
	let m;
	const seen = new Set();
	while ((m = re.exec(html)) !== null) {
		const eventUrl = decodeEntities(m[1]);
		let title = stripHtml(m[2])
			.replace(/^(More details\s*)+/i, "")
			.replace(/\s*Tickets\s*$/i, "")
			.replace(/^(Tickets\s*)+/i, "")
			.trim();
		const dateBlock = stripHtml(m[3]);
		if (!title || /^more details$/i.test(title)) continue;
		const dm = dateBlock.match(
			/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\s+(?:from|at)\s+(\d{1,2}:\d{2}\s*[ap]m)(?:\s+to\s+(\d{1,2}:\d{2}\s*[ap]m))?/i,
		);
		if (!dm) continue;
		const month = MONTHS[dm[1].toLowerCase().slice(0, 3)];
		const day = Number(dm[2]);
		const year = Number(dm[3]);
		const startClock = parseClock(dm[4]);
		const endClock = dm[5] ? parseClock(dm[5]) : null;
		if (!month || !day || !startClock) continue;
		const date = ymd(year, month, day);
		const starts_at = localToUtc(date, startClock);
		const ends_at = endClock ? localToUtc(date, endClock) : null;
		const k = key(title, starts_at);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({
			title,
			starts_at,
			ends_at,
			ticket_url: eventUrl,
			source_url: eventUrl,
			source_event_id: `vulcan-ts|${eventUrl.split("/").pop()}`,
			raw_date_text: dateBlock,
			image_url: null,
		});
	}
	return out;
}

function merge(a, b) {
	const map = new Map();
	for (const e of [...a, ...b]) {
		const k = key(e.title, e.starts_at);
		const prev = map.get(k);
		if (!prev) map.set(k, e);
		else
			map.set(k, {
				...prev,
				...e,
				ticket_url: e.ticket_url || prev.ticket_url,
				ends_at: e.ends_at || prev.ends_at,
				source_url: e.source_url || prev.source_url,
			});
	}
	return [...map.values()]
		.filter((e) => +new Date(e.starts_at) > Date.now() - 12 * 3600e3)
		.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
}

console.log("\n=== Vulcan stage to pending ===\n");

const home = await get("https://www.vulcanatx.com/");
const ts = await get("https://vulcanatx.ticketsauce.com/");
const events = merge(parseHome(home), parseTs(ts));
console.log("parsed events", events.length);
for (const e of events.slice(0, 8)) {
	console.log(" -", e.starts_at.slice(0, 16), e.title.slice(0, 50));
}

// enable source
await sb
	.from("venue_event_sources")
	.update({
		is_enabled: true,
		platform_type: "custom_html",
		calendar_url: "https://www.vulcanatx.com/",
		feed_url: "https://www.vulcanatx.com/",
		scrape_days_ahead: 120,
		publish_mode: "draft",
		last_scrape_status: "success",
		last_scrape_error: null,
		last_scrape_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	})
	.eq("venue_id", VENUE_ID);

await sb
	.from("venues")
	.update({
		calendar_url: "https://www.vulcanatx.com/",
		website_url: "https://www.vulcanatx.com/",
		updated_at: new Date().toISOString(),
	})
	.eq("id", VENUE_ID);

// clear prior pending
await sb
	.from("ingested_events")
	.update({ review_status: "rejected", reviewed_at: new Date().toISOString() })
	.eq("venue_id", VENUE_ID)
	.eq("review_status", "pending");

const { data: run, error: runErr } = await sb
	.from("ingestion_runs")
	.insert({
		site_id: SITE_ID,
		venue_id: VENUE_ID,
		status: "success",
		finished_at: new Date().toISOString(),
	})
	.select("id")
	.single();
if (runErr) throw new Error(runErr.message);

const rows = events.map((e) => ({
	ingestion_run_id: run.id,
	venue_id: VENUE_ID,
	raw_title: e.title,
	raw_date_text: e.raw_date_text,
	parsed_starts_at: e.starts_at,
	parsed_ends_at: e.ends_at,
	source_url: e.source_url,
	source_event_id: e.source_event_id,
	fingerprint: fp(e.title, e.starts_at, e.ticket_url),
	source_partner: "vulcan_atx",
	review_status: "pending",
	match_status: "new",
	matched_event_id: null,
	matched_artist_id: null,
	artist_match_status: "unmatched",
	extracted_band_name: e.title.split(/[:–|]/)[0].trim().slice(0, 120),
	raw_payload: {
		title: e.title,
		starts_at: e.starts_at,
		ends_at: e.ends_at,
		ticket_url: e.ticket_url ?? e.source_url,
		image_url: e.image_url,
		source_url: e.source_url,
		source_partner: "vulcan_atx",
		description: null,
		confidence: e.ticket_url ? 0.95 : 0.85,
		import_method: "feed",
		platform: "vulcan_atx",
	},
}));

// insert in chunks
let inserted = 0;
for (let i = 0; i < rows.length; i += 25) {
	const chunk = rows.slice(i, i + 25);
	const { error, data } = await sb.from("ingested_events").insert(chunk).select("id");
	if (error) {
		console.error("insert fail", error.message);
		// try one-by-one
		for (const row of chunk) {
			const { error: e2 } = await sb.from("ingested_events").insert(row);
			if (e2) console.error("  row", row.raw_title, e2.message);
			else inserted++;
		}
	} else {
		inserted += data?.length ?? chunk.length;
	}
}

console.log(`\nStaged ${inserted} pending rows for Vulcan Gas Company`);
console.log("Admin: https://events-platform-admin.ben-745.workers.dev/ingestion");
console.log("Filter venue: vulcan-gas-company");
