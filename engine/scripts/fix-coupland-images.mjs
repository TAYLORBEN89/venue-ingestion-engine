/**
 * Re-stage Coupland Dancehall with Squarespace show posters.
 * Images live in data-image / data-src on the shows page.
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
const CAL = "https://www.couplanddancehall.com/shows";

const MONTHS = {
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

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
	return (
		(Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second) - at.getTime()) /
		60000
	);
}
function localToUtc(local) {
	const [datePart, timePart] = local.replace("T", " ").split(" ");
	const [y, m, d] = datePart.split("-").map(Number);
	const [hh, mm, ss = 0] = timePart.split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, +ss));
	return new Date(guess.getTime() - getOffsetMin(TZ, guess) * 60000).toISOString();
}
function stripHtml(v) {
	return String(v || "")
		.replace(/&amp;/gi, "&")
		.replace(/&#x27;|&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
function titleCase(s) {
	return s
		.toLowerCase()
		.replace(/\b([a-z])/g, (c) => c.toUpperCase())
		.replace(/\b(And|The|Of|At|With|Ft|Feat)\b/g, (w) => w.toLowerCase())
		.replace(/^\w/, (c) => c.toUpperCase());
}
function fp(title, starts, ticket) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${ticket ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}
function hype(band, venue, startsAt, i) {
	const date = new Date(startsAt).toLocaleDateString("en-US", {
		timeZone: TZ,
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	});
	const time = new Date(startsAt).toLocaleTimeString("en-US", {
		timeZone: TZ,
		hour: "numeric",
		minute: "2-digit",
	});
	const openers = [
		`Catch ${band} live at ${venue} on ${date}.`,
		`${band} hits the stage at ${venue} on ${date}.`,
		`Don't miss ${band} at ${venue} — ${date}.`,
		`${band} brings the heat to ${venue} on ${date}.`,
		`See ${band} under the lights at ${venue} on ${date}.`,
	];
	return `${openers[i % openers.length]} Texas dancehall energy and a night worth showing up early for. Showtime around ${time}. Grab tickets and get there early.`;
}
function cleanImageUrl(url) {
	if (!url) return null;
	// Prefer full-size without format=100w style query when possible
	return url.split("?")[0];
}

const html = await (
	await fetch(CAL, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
		},
	})
).text();

const yearNow = new Date().getFullYear();
const events = [];
const seen = new Set();

// image → h2 title → date → etix (structure on /shows)
const re =
	/data-image="(https:\/\/images\.squarespace-cdn\.com\/content\/v1\/[^"]+)"[\s\S]{0,5000}?<h2[^>]*>\s*<strong>\s*([^<]+)\s*<\/strong>[\s\S]{0,2000}?(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),\s*(?:(\d{1,2})\/(\d{1,2})\/(\d{2})|([A-Z]+)\s+(\d{1,2})(?:ST|ND|RD|TH)?)[\s\S]{0,1500}?href="(https:\/\/(?:www\.)?etix\.com\/ticket\/p\/(\d+)\/[^"]+)"/gi;

for (const m of html.matchAll(re)) {
	const image_url = cleanImageUrl(m[1]);
	const title = titleCase(stripHtml(m[2]));
	const ticket = m[8];
	const id = m[9];
	if (!title || seen.has(id)) continue;
	// skip logo/nav images mistakenly paired
	const file = decodeURIComponent((image_url || "").split("/").pop() || "");
	if (/logo|favicon/i.test(file)) continue;
	seen.add(id);

	let date;
	if (m[3] && m[4] && m[5]) {
		date = `20${m[5]}-${String(+m[3]).padStart(2, "0")}-${String(+m[4]).padStart(2, "0")}`;
	} else {
		const mon = MONTHS[String(m[6]).toLowerCase()];
		if (!mon) continue;
		date = `${yearNow}-${String(mon).padStart(2, "0")}-${String(+m[7]).padStart(2, "0")}`;
	}

	const doorsWin = html.slice(m.index, m.index + (m[0]?.length || 2000));
	const doors = doorsWin.match(/Doors?\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i)?.[1];
	let time = "19:00";
	if (doors) {
		const t = doors.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
		if (t) {
			let h = +t[1];
			const min = t[2] || "00";
			const ap = t[3].toLowerCase();
			if (ap === "pm" && h < 12) h += 12;
			if (ap === "am" && h === 12) h = 0;
			time = `${String(h).padStart(2, "0")}:${min}`;
		}
	}

	const starts_at = localToUtc(`${date} ${time}:00`);
	if (+new Date(starts_at) < Date.now() - 864e5) continue;

	events.push({
		title,
		band: title,
		starts_at,
		image_url,
		source_url: ticket,
		source_event_id: `etix-${id}`,
		raw_date_text: date,
		ticket_url: ticket,
		confidence: 0.92,
	});
}

events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(`Parsed ${events.length} Coupland shows with images ${events.filter((e) => e.image_url).length}`);
for (const e of events.slice(0, 8)) {
	const file = decodeURIComponent((e.image_url || "").split("/").pop() || "").slice(0, 55);
	console.log(
		" ",
		new Date(e.starts_at).toLocaleString("en-US", {
			timeZone: TZ,
			month: "short",
			day: "numeric",
		}),
		e.title.slice(0, 35),
		file,
	);
}

if (!events.length) {
	console.error("No events — abort");
	process.exit(1);
}

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id, name")
	.eq("site_id", site.id)
	.eq("slug", "coupland-dancehall")
	.single();

await sb.from("venues").update({ calendar_url: CAL, website_url: "https://www.couplanddancehall.com/" }).eq("id", venue.id);

const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({
			platform_type: "etix",
			feed_url: CAL,
			calendar_url: CAL,
			updated_at: new Date().toISOString(),
		})
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "etix",
		feed_url: CAL,
		calendar_url: CAL,
		is_enabled: true,
	});
}

await sb
	.from("ingested_events")
	.update({ review_status: "rejected", reviewed_at: new Date().toISOString() })
	.eq("venue_id", venue.id)
	.eq("review_status", "pending");

const { data: run } = await sb
	.from("ingestion_runs")
	.insert({ site_id: site.id, venue_id: venue.id, status: "success", finished_at: new Date().toISOString() })
	.select("id")
	.single();

const venueName = "Coupland Dancehall";
const rows = events.map((e, i) => {
	const desc = hype(e.band, venueName, e.starts_at, i);
	return {
		ingestion_run_id: run.id,
		venue_id: venue.id,
		raw_title: e.title,
		raw_date_text: e.raw_date_text,
		parsed_starts_at: e.starts_at,
		parsed_ends_at: null,
		source_url: e.source_url,
		source_event_id: e.source_event_id,
		fingerprint: fp(e.title, e.starts_at, e.ticket_url),
		source_partner: "etix",
		extracted_band_name: e.band,
		matched_artist_id: null,
		artist_match_status: "unmatched",
		match_status: "new",
		matched_event_id: null,
		review_status: "pending",
		raw_payload: {
			description: desc,
			event_intro: desc,
			price_text: null,
			ticket_url: e.ticket_url,
			image_url: e.image_url,
			confidence: e.confidence,
			import_method: "feed",
			platform: "etix",
		},
	};
});

const { error } = await sb.from("ingested_events").insert(rows);
if (error) throw new Error(error.message);

console.log(`\n=== Coupland Dancehall === staged ${rows.length} images ${rows.filter((r) => r.raw_payload.image_url).length}`);
console.log("Done → https://events-platform-admin.ben-745.workers.dev/ingestion");
