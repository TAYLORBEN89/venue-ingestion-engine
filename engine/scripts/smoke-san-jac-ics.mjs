/**
 * San Jac Saloon — calendar scrape smoke / full harvest (local, no DB writes).
 *
 * ─── Walkthrough (what you see on the page) ─────────────────────────────
 * Start: https://www.sanjacsaloon.com/events
 *
 * Two Google Calendar embeds (month view; chevrons change months):
 *   1) Downstairs / "SJS Shows"
 *      <iframe src="https://calendar.google.com/calendar/embed?src=sanjacsaloon%40gmail.com&ctz=America%2FChicago" …>
 *   2) Upstairs / Jack's Room
 *      <iframe src="https://calendar.google.com/calendar/embed?src=mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com&ctz=America%2FChicago" …>
 *
 * Month navigation: chevron controls inside each embed
 *   (Google UI: .pYTkkf-Bz112c-RLmnJb / prev-next month buttons)
 *
 * Day cell / event list structure inside the embed:
 *   - Day group header e.g.
 *       <h2 class="CqwSk XuJrye" id="c314">3 events, Sunday, June 28</h2>
 *   - Event lines e.g.
 *       <span class="XuJrye">1:30pm to 4:30pm, Bron Burbank, Calendar: SJS Shows, No location, June 28, 2026</span>
 *       <span class="XuJrye">5pm to 8pm, Eric Bowden, Calendar: SJS Shows, No location, June 28, 2026</span>
 *
 * ─── How we scrape (same data, no browser) ──────────────────────────────
 * Google Calendar public ICS for those exact `src=` calendars:
 *   Downstairs: …/ical/sanjacsaloon@gmail.com/public/basic.ics
 *   Upstairs:   …/ical/mfgm3bii42jvfbluljkje8p2b0@group.calendar.google.com/public/basic.ics
 *
 * Mapping UI line → ICS VEVENT:
 *   "1:30pm to 4:30pm, Bron Burbank, Calendar: SJS Shows, …"
 *     → SUMMARY = Bron Burbank
 *     → DTSTART / DTEND = 1:30pm–4:30pm America/Chicago that day
 *
 * ─── Horizons ───────────────────────────────────────────────────────────
 *   Pilot (default for ongoing pilot): 1 month from today  →  --days=30
 *   Full calendar scrape (now): all future VEVENTs         →  --full
 *
 * Usage (from apps/ingestion):
 *   node scripts/smoke-san-jac-ics.mjs              # pilot horizon (30d)
 *   node scripts/smoke-san-jac-ics.mjs --full       # full future scrape
 *   node scripts/smoke-san-jac-ics.mjs --days=90
 *   node scripts/smoke-san-jac-ics.mjs --full --json=../../scripts/tmp-sanjac-full-scrape.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FULL = process.argv.includes("--full");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = FULL ? null : Number(daysArg?.split("=")[1] || 30);
const jsonArg = process.argv.find((a) => a.startsWith("--json="));
const JSON_OUT = jsonArg ? jsonArg.split("=")[1] : null;

const FEEDS = [
	{
		room: "downstairs",
		calendarLabel: "SJS Shows",
		label: "Downstairs live music (sanjacsaloon@gmail.com)",
		embed: "https://calendar.google.com/calendar/embed?src=sanjacsaloon%40gmail.com&ctz=America%2FChicago",
		ics: "https://calendar.google.com/calendar/ical/sanjacsaloon%40gmail.com/public/basic.ics",
	},
	{
		room: "upstairs",
		calendarLabel: "Upstairs / Jack's Room",
		label: "Upstairs group calendar",
		embed:
			"https://calendar.google.com/calendar/embed?src=mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com&ctz=America%2FChicago",
		ics: "https://calendar.google.com/calendar/ical/mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com/public/basic.ics",
	},
];

const PAGE = "https://www.sanjacsaloon.com/events";

function unfold(text) {
	return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseIcsDate(raw) {
	if (!raw) return null;
	const z = String(raw).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
	if (z) return new Date(`${z[1]}-${z[2]}-${z[3]}T${z[4]}:${z[5]}:${z[6]}Z`);
	const local = String(raw).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
	// Floating local times on San Jac ICS are America/Chicago wall clock.
	// Use fixed -05:00 (CDT). Good enough for scrape listing; ingest path uses ical.ts.
	if (local) {
		return new Date(
			`${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6]}-05:00`,
		);
	}
	const day = String(raw).match(/^(\d{4})(\d{2})(\d{2})$/);
	if (day) return new Date(`${day[1]}-${day[2]}-${day[3]}T00:00:00-05:00`);
	return null;
}

function parseIcs(text) {
	const raw = unfold(text);
	const blocks = raw.split("BEGIN:VEVENT").slice(1);
	const events = [];
	for (const b of blocks) {
		const chunk = b.split("END:VEVENT")[0];
		const get = (key) => {
			const m = chunk.match(new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, "im"));
			return m ? m[1].trim() : null;
		};
		const summary = (get("SUMMARY") || "").replace(/\\,/g, ",").replace(/\\n/g, " ").trim();
		const desc = (get("DESCRIPTION") || "").replace(/\\n/g, "\n").replace(/\\,/g, ",");
		const loc = (get("LOCATION") || "").replace(/\\,/g, ",");
		const dtMatch = chunk.match(/^DTSTART[^:]*:(.+)$/im);
		const dtEndMatch = chunk.match(/^DTEND[^:]*:(.+)$/im);
		const uid = get("UID");
		const startRaw = dtMatch ? dtMatch[1].trim() : null;
		const endRaw = dtEndMatch ? dtEndMatch[1].trim() : null;
		const start = parseIcsDate(startRaw);
		const end = parseIcsDate(endRaw);
		if (!summary || !start) continue;
		events.push({ summary, description: desc, location: loc, start, end, startRaw, endRaw, uid });
	}
	return events;
}

function isNoiseTitle(title) {
	const t = String(title || "").trim().toLowerCase();
	if (!t || t.length < 2) return true;
	if (/^\(empty\)$/i.test(t) || t === "empty") return true;
	if (/^(closed|private|party|hours|happy hour|tbd|tba|open|no band|showx|busy)$/i.test(t)) return true;
	if (/\b(hours|happy hour|specialty cocktails|speciality cocktails|watch party)\b/i.test(t)) return true;
	return false;
}

/** UI: "1:30pm to 4:30pm, Bron Burbank, Calendar: SJS Shows, …" → artist name */
function cleanArtist(summary) {
	let s = String(summary || "").replace(/\s+/g, " ").trim();
	s = s.replace(/\s*[-–—|]\s*(san jac|sanjac|saloon|jack'?s|upstairs|downstairs).*$/i, "");
	s = s.replace(/\?+$/g, "").trim();
	// Strip trailing schedule junk if someone put times in SUMMARY (rare)
	s = s.replace(/^\d{1,2}:\d{2}\s*(am|pm)\s*to\s*.*?,\s*/i, "");
	return s;
}

function fmtLocal(d) {
	if (!d) return null;
	return d.toLocaleString("en-US", {
		timeZone: "America/Chicago",
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

console.log("\n=== San Jac calendar scrape ===\n");
console.log("Page:", PAGE);
console.log("Mode:", FULL ? "FULL future calendar" : `PILOT horizon ${DAYS} days from today`);
console.log("Today (UTC):", new Date().toISOString().slice(0, 10));

// Confirm embeds still present
try {
	const pageRes = await fetch(PAGE, {
		headers: { "user-agent": "HeyAustinSanJacPilot/1.0", accept: "text/html" },
	});
	const html = await pageRes.text();
	const hasMain = /calendar\.google\.com\/calendar\/embed\?src=sanjacsaloon/i.test(html);
	const hasUp =
		/calendar\.google\.com\/calendar\/embed\?src=mfgm3bii42jvfbluljkje8p2b0/i.test(html) ||
		/group\.calendar\.google\.com/i.test(html);
	console.log("Page HTTP:", pageRes.status);
	console.log("Embed downstairs (sanjacsaloon@gmail):", hasMain ? "yes" : "NO");
	console.log("Embed upstairs (group):", hasUp ? "yes" : "NO");
} catch (e) {
	console.warn("Page fetch warning:", e.message);
}

const now = Date.now();
const horizonMs = DAYS == null ? null : now + DAYS * 86400000;
const allRows = [];

for (const feed of FEEDS) {
	console.log(`\n--- ${feed.room}: ${feed.label} ---`);
	console.log("ICS:", feed.ics);
	const res = await fetch(feed.ics, {
		headers: { "user-agent": "HeyAustinSanJacPilot/1.0", accept: "text/calendar" },
	});
	const text = await res.text();
	console.log("HTTP", res.status, "bytes", text.length);
	if (!res.ok || !/BEGIN:VCALENDAR/i.test(text)) {
		console.error("FAIL: invalid ICS");
		continue;
	}
	const events = parseIcs(text);
	const filtered = events.filter((e) => {
		const t = e.start.getTime();
		if (t < now - 3600000) return false; // drop past (1h slack)
		if (horizonMs != null && t > horizonMs) return false;
		return true;
	});
	const playable = filtered.filter((e) => !isNoiseTitle(e.summary));
	const noise = filtered.length - playable.length;
	console.log(
		"VEVENT total:",
		events.length,
		"| in window:",
		filtered.length,
		"| playable:",
		playable.length,
		"| noise:",
		noise,
	);

	// Group by Chicago calendar day (like UI day headers)
	const byDay = new Map();
	for (const e of playable) {
		const dayKey = e.start.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD
		if (!byDay.has(dayKey)) byDay.set(dayKey, []);
		byDay.get(dayKey).push(e);
	}
	const days = [...byDay.keys()].sort();
	console.log("Days with shows:", days.length);
	for (const day of days.slice(0, FULL ? 999 : 14)) {
		const list = byDay.get(day).sort((a, b) => a.start - b.start);
		const sampleDate = list[0].start;
		const dayLabel = sampleDate.toLocaleDateString("en-US", {
			timeZone: "America/Chicago",
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric",
		});
		console.log(`  ${list.length} event(s), ${dayLabel}`);
		for (const e of list) {
			const artist = cleanArtist(e.summary);
			const timeRange = `${fmtLocal(e.start)} → ${e.end ? fmtLocal(e.end) : "?"}`;
			console.log(`    · ${timeRange} | ${artist}`);
			allRows.push({
				room: feed.room,
				calendarLabel: feed.calendarLabel,
				uid: e.uid,
				summary: e.summary,
				artist,
				starts_at: e.start.toISOString(),
				ends_at: e.end?.toISOString() ?? null,
				starts_local: fmtLocal(e.start),
				ends_local: e.end ? fmtLocal(e.end) : null,
				location: e.location || null,
				source_ics: feed.ics,
			});
		}
	}
	if (!FULL && days.length > 14) console.log("  ...", days.length - 14, "more days (use --full to print all)");
}

// Dedupe across rooms
const seen = new Set();
const unique = [];
for (const r of allRows) {
	const k = r.uid || `${r.starts_at}|${r.artist}|${r.room}`;
	if (seen.has(k)) continue;
	seen.add(k);
	unique.push(r);
}
unique.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

console.log("\n=== summary ===");
console.log("Playable rows:", allRows.length);
console.log("Unique playable:", unique.length);
const artists = new Map();
for (const r of unique) artists.set(r.artist, (artists.get(r.artist) || 0) + 1);
console.log("Distinct artist names:", artists.size);
console.log(
	"Top artists:",
	[...artists.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15)
		.map(([n, c]) => `${n}(${c})`)
		.join(" · "),
);

const report = {
	scraped_at: new Date().toISOString(),
	page: PAGE,
	mode: FULL ? "full" : "pilot_1_month",
	days_horizon: DAYS,
	feeds: FEEDS.map((f) => ({ room: f.room, ics: f.ics, embed: f.embed })),
	ui_notes: {
		day_header_example: "3 events, Sunday, June 28",
		event_line_example:
			"1:30pm to 4:30pm, Bron Burbank, Calendar: SJS Shows, No location, June 28, 2026",
		month_nav: "Google embed chevrons (.pYTkkf-Bz112c-RLmnJb)",
	},
	counts: {
		playable_rows: allRows.length,
		unique_playable: unique.length,
		distinct_artists: artists.size,
	},
	events: unique,
};

if (JSON_OUT) {
	const outPath = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.resolve(process.cwd(), JSON_OUT);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
	console.log("\nWrote", outPath);
} else {
	// default dump for full mode
	if (FULL) {
		const outPath = path.join(__dirname, "../../scripts/tmp-sanjac-full-scrape.json");
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
		console.log("\nWrote", outPath);
	}
}

const ok = unique.length > 0;
console.log(ok ? "\nSCRAPE OK" : "\nSCRAPE FAIL — no playable events");
process.exit(ok ? 0 : 1);
