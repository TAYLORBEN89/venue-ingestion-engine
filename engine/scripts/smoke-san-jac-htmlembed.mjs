/**
 * San Jac Saloon smoke / full scrape via Google Calendar classic htmlembed.
 *
 * Walkthrough (Jul 17, 2026 on first calendar):
 *   Page: https://www.sanjacsaloon.com/events
 *   Iframe: src=sanjacsaloon@gmail.com (SJS Shows)
 *   Day cell: data-datekey + <h2>17</h2>
 *   Events:
 *     3pm–6pm Aaron Navarro Duo
 *     6:30pm–9:30pm Ben Cina
 *     10pm Aaron Navarro Band
 *
 * Scrape: classic htmlembed agenda (static HTML with all slots):
 *   <div class="date">Fri Jul 17, 2026</div>
 *   <tr class="event"><td class="event-time">3pm</td>…Aaron Navarro Duo
 *
 * NOTE: public basic.ics is incomplete (Jul 17 ICS only had Ben Cina).
 * Use this script for accurate multi-band days.
 *
 * Usage (from apps/ingestion):
 *   node scripts/smoke-san-jac-htmlembed.mjs              # pilot: 1 month
 *   node scripts/smoke-san-jac-htmlembed.mjs --full       # through October of this year
 *   node scripts/smoke-san-jac-htmlembed.mjs --months=4
 *   node scripts/smoke-san-jac-htmlembed.mjs --full --json=../../scripts/tmp-sanjac-full-scrape.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
	SAN_JAC_PAGE,
	scrapeSanJac,
	isNoiseArtist,
} from "./lib/san-jac-htmlembed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FULL = process.argv.includes("--full");
const monthsArg = process.argv.find((a) => a.startsWith("--months="));

/** Months from current Chicago month through October (same year). Cap at Oct. */
function monthsThroughOctober(fromDate = new Date()) {
	const parts = fromDate
		.toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
		.split("-")
		.map(Number);
	const month = parts[1]; // 1–12
	// Jul→Oct = 4; if already past Oct, 0 (caller should handle)
	if (month > 10) return 0;
	return 11 - month; // e.g. Jul(7) → 4 months (Jul,Aug,Sep,Oct)
}

const defaultFullMonths = monthsThroughOctober();
const MONTHS = monthsArg
	? Number(monthsArg.split("=")[1])
	: FULL
		? Math.max(defaultFullMonths, 1)
		: 1;
const jsonArg = process.argv.find((a) => a.startsWith("--json="));
const JSON_OUT =
	jsonArg?.split("=")[1] ||
	(FULL ? path.join(__dirname, "../../scripts/tmp-sanjac-full-scrape.json") : null);

console.log("\n=== San Jac htmlembed scrape ===\n");
console.log("Page:", SAN_JAC_PAGE);
console.log("Mode:", FULL ? `FULL ${MONTHS} months ahead` : `PILOT ${MONTHS} month(s)`);
console.log("Source: classic Google Calendar htmlembed agenda (not basic.ics)\n");

const { events, diagnostics } = await scrapeSanJac({ monthCount: MONTHS });
// Cap at end of October (same year as scrape start)
const octYear = new Date()
	.toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
	.slice(0, 4);
const maxDate = `${octYear}-10-31`;
const playable = events.filter(
	(e) => !isNoiseArtist(e.artist) && e.iso_date && e.iso_date <= maxDate,
);
console.log("Date cap: through", maxDate, "(build through October only)");

// Group by day for display
const byDay = new Map();
for (const e of playable) {
	const k = `${e.room}|${e.iso_date}`;
	if (!byDay.has(k)) byDay.set(k, []);
	byDay.get(k).push(e);
}

console.log("Diagnostics (per room/month):");
for (const d of diagnostics) {
	console.log(
		`  ${d.room} ${d.month}: HTTP ${d.status} bytes=${d.bytes} events=${d.events}`,
	);
}

console.log("\n=== Playable shows by day ===");
const keys = [...byDay.keys()].sort();
for (const k of keys) {
	const list = byDay.get(k).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	const sample = list[0];
	console.log(`\n${list.length} event(s) — ${sample.date_label} [${sample.room}]`);
	for (const e of list) {
		console.log(`  ${e.time_raw.padEnd(7)} | ${e.artist}`);
	}
}

// Prove Jul 17 downstairs
const jul17 = playable.filter((e) => e.iso_date === "2026-07-17" && e.room === "downstairs");
console.log("\n=== Verify Jul 17 downstairs (expect 3 bands) ===");
if (!jul17.length) console.log("  MISSING — scrape failed for Jul 17");
else for (const e of jul17) console.log(`  ${e.time_raw} | ${e.artist}`);

const artists = new Map();
for (const e of playable) artists.set(e.artist, (artists.get(e.artist) || 0) + 1);

const report = {
	scraped_at: new Date().toISOString(),
	page: SAN_JAC_PAGE,
	mode: FULL ? "full" : "pilot_1_month",
	months: MONTHS,
	method: "google_calendar_htmlembed_agenda",
	ui_walkthrough: {
		jul_17_2026_downstairs: [
			"3pm to 6pm, Aaron Navarro Duo",
			"6:30pm to 9:30pm, Ben Cina",
			"10pm Aaron Navarro Band",
		],
		dom_spa: {
			date_cell: 'data-datekey + h2.w48V4c "17"',
			event_line: 'span.XuJrye "3pm to 6pm, Aaron Navarro Duo, Calendar: SJS Shows, …"',
			short_line: "span.DvyQhe 10pm + span.WBi6vc Aaron Navarro Band",
		},
		scrape_html: {
			date: 'div.date "Fri Jul 17, 2026"',
			row: 'tr.event > td.event-time + span.event-summary',
		},
		note: "basic.ics incomplete (Jul 17 only Ben Cina). htmlembed matches UI multi-band days.",
	},
	diagnostics,
	counts: {
		raw_events: events.length,
		playable: playable.length,
		days: byDay.size,
		distinct_artists: artists.size,
		jul17_downstairs: jul17.length,
	},
	top_artists: [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
	events: playable,
};

console.log("\n=== summary ===");
console.log("Playable events:", playable.length);
console.log("Days with shows:", byDay.size);
console.log("Distinct artists:", artists.size);
console.log("Jul 17 downstairs count:", jul17.length, jul17.length >= 3 ? "OK" : "CHECK");

if (JSON_OUT) {
	const outPath = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.resolve(process.cwd(), JSON_OUT);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
	console.log("Wrote", outPath);
}

const ok = playable.length > 0 && jul17.length >= 3;
console.log(ok ? "\nSCRAPE OK — multi-band days match UI" : "\nSCRAPE NEEDS CHECK");
process.exit(ok ? 0 : 1);
