/**
 * Poodie's calendar scrape — pages + music.html + month PNGs.
 *
 *   node venues/poodie-s-hilltop-roadhouse/scrape-poodies-calendar.mjs
 *   node venues/poodie-s-hilltop-roadhouse/scrape-poodies-calendar.mjs --year=2026
 *
 * Writes:
 *   tmp-enhance/poodies/scrape-manifest.json
 *   tmp-enhance/poodies/slots-from-music.json  (parsed from music.html)
 *   tmp-enhance/poodies/{month}.png
 *   venues/poodie-s-hilltop-roadhouse/slots-merged.json (music + august fixture)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "tmp-enhance", "poodies");
const PACKET = __dirname;

const CALENDAR = "https://poodies.net/calendar.html";
const CALENDAR_NEXT = "https://poodies.net/calendar-next.html";
const MUSIC = "https://poodies.net/music.html";
const UA = "Mozilla/5.0 (compatible; HeyAustinBot/1.0; +https://heyaustin.com)";

const YEAR = Number(
	(process.argv.find((a) => a.startsWith("--year=")) || "").slice(7) || new Date().getFullYear(),
);

function decodeEntities(s) {
	return String(s || "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#039;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\u00a0/g, " ");
}

function stripTags(html) {
	return decodeEntities(
		String(html || "")
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|tr|h\d|li|td)>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/\n{2,}/g, "\n")
			.trim(),
	);
}

async function fetchText(url) {
	const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.text();
}

async function download(url, dest) {
	const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(dest, buf);
	return buf.length;
}

function absUrl(href, base = "https://poodies.net/") {
	if (!href) return null;
	if (/^https?:\/\//i.test(href)) return href;
	if (href.startsWith("//")) return `https:${href}`;
	if (href.startsWith("/")) return `https://poodies.net${href}`;
	return new URL(href, base).href;
}

function extractCalendarImage(html) {
	const m =
		html.match(/src=["']([^"']*\/images\/events\/calendar\/[a-z]+\.png)["']/i) ||
		html.match(/src=["']([^"']*calendar\/[a-z]+\.png)["']/i);
	return m ? absUrl(m[1]) : null;
}

function monthNameToNum(name) {
	const map = {
		january: 1,
		february: 2,
		march: 3,
		april: 4,
		may: 5,
		june: 6,
		july: 7,
		august: 8,
		september: 9,
		october: 10,
		november: 11,
		december: 12,
	};
	return map[String(name || "").toLowerCase()] || null;
}

function parseClock(text) {
	const m = String(text).match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
	if (!m) return null;
	let h = Number(m[1]);
	const min = Number(m[2] || "0");
	const ap = m[3].toUpperCase();
	if (ap === "PM" && h < 12) h += 12;
	if (ap === "AM" && h === 12) h = 0;
	return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Parse music.html day blocks into slots.
 * Pattern: **Wednesday July 1** then acts with times.
 */
function parseMusicHtml(html, year = YEAR) {
	const text = stripTags(html);
	const slots = [];
	// Split on day headers like "Wednesday July 1" or "Friday July 31"
	const dayRe =
		/(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?/gi;
	const matches = [...text.matchAll(dayRe)];
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		const mon = monthNameToNum(m[1]);
		const day = Number(m[2]);
		if (!mon || !day) continue;
		const date = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		const startIdx = m.index + m[0].length;
		const endIdx = i + 1 < matches.length ? matches[i + 1].index : text.length;
		const block = text.slice(startIdx, endIdx);

		// Songwriters showcase block
		const showcase = block.match(
			/SONGWRITERS?\s+SHOWCASE\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))[\s\S]{0,400}?Special\s+Guest[s]?\s+([A-Za-z0-9 .,&'’\-]+?)(?:\s{2,}|\n|$)/i,
		);
		const hostMatch = block.match(
			/([A-Za-z0-9 .,&'’\-]+?)\s+Hosts(?:\s|$)/i,
		);
		if (showcase) {
			const start = parseClock(showcase[1]);
			const guest = showcase[2].replace(/\s+/g, " ").trim();
			const host = hostMatch?.[1]?.replace(/\s+/g, " ").trim() || null;
			if (start) {
				slots.push({
					date,
					start,
					title: "Songwriters Showcase",
					kind: "song_swap",
					host,
					guest,
					face: guest,
					artists: [host, guest].filter(Boolean),
					source: "music.html",
				});
			}
		}

		// Song swap: Andrea Marie Hosts Song Swap / Song Swap with X
		const songSwap = block.match(
			/([A-Za-z0-9 .,&'’\-]+?)\s+Hosts?\s+Song\s+Swap(?:\s+with\s+([A-Za-z0-9 .,&'’\-]+))?[^\n]*?(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i,
		);
		if (songSwap && !showcase) {
			const host = songSwap[1].replace(/\s+/g, " ").trim();
			const guest = (songSwap[2] || "").replace(/\s+/g, " ").trim() || null;
			const start = parseClock(songSwap[3]);
			if (start) {
				slots.push({
					date,
					start,
					title: guest ? `${host} Song Swap with ${guest}` : `${host} Song Swap`,
					kind: "song_swap",
					host,
					guest,
					face: guest || host,
					artists: [host, guest].filter(Boolean),
					source: "music.html",
				});
			}
		}

		// Open mic
		const openMic = block.match(
			/No\s+Bad\s+Wednes?days?\s+Open\s+Mic\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i,
		);
		if (openMic) {
			const start = parseClock(openMic[1]);
			const host =
				block.match(/([A-Za-z0-9 .,&'’\-]+?)\s+Hosts(?:\s+Blues)?/i)?.[1]?.trim() || null;
			if (start) {
				slots.push({
					date,
					start,
					title: "No Bad Wednesdays Open Mic",
					host,
					face: host,
					artists: host ? [host] : [],
					optional: true,
					source: "music.html",
				});
			}
		}

		// Generic "Act Name TIME" lines — require Name then time on same-ish line
		const actRe =
			/([A-Za-z0-9][A-Za-z0-9 .,&'’+\-\/]{1,60}?)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/gi;
		const seenStarts = new Set(slots.filter((s) => s.date === date).map((s) => s.start));
		for (const am of block.matchAll(actRe)) {
			let name = am[1].replace(/\s+/g, " ").trim();
			// Noise filters
			if (
				/^(special\s+guest|guests?|more\s+great|click\here|red,?\s*white|steak\s+night|no\s+bad|songwriters?|song\s+swap|hosts?)$/i.test(
					name,
				)
			)
				continue;
			if (/Hosts$/i.test(name)) continue;
			if (/^Special\s+Guest/i.test(name)) {
				name = name.replace(/^Special\s+Guests?\s+/i, "").trim();
			}
			// Strip trailing junk
			name = name
				.replace(/\s+(Hosts|Host)$/i, "")
				.replace(/^and\s+/i, "")
				.trim();
			const start = parseClock(am[2]);
			if (!start || !name || name.length < 2) continue;
			if (seenStarts.has(start)) continue;
			// Skip if looks like pure showcase already handled
			if (/songwriters?\s+showcase/i.test(name)) continue;
			if (/no\s+bad\s+wednes/i.test(name)) continue;

			// Duo / Madam Radar
			if (/madam\s+radar\s+duo/i.test(name)) name = "Madam Radar Duo";

			seenStarts.add(start);
			const isDuo = /madam\s+radar\s+duo/i.test(name);
			slots.push({
				date,
				start,
				title: name,
				face: name,
				artists: [name],
				...(isDuo ? { note: "duo_not_full_band" } : {}),
				source: "music.html",
			});
		}
	}

	// Dedup by date+start+title
	const key = (s) => `${s.date}|${s.start}|${s.title.toLowerCase()}`;
	const uniq = new Map();
	for (const s of slots) {
		if (!uniq.has(key(s))) uniq.set(key(s), s);
	}
	return [...uniq.values()].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

fs.mkdirSync(OUT, { recursive: true });

console.log("=== Poodie's calendar scrape ===\n");

const [calHtml, nextHtml, musicHtml] = await Promise.all([
	fetchText(CALENDAR),
	fetchText(CALENDAR_NEXT),
	fetchText(MUSIC),
]);

const julyImg = extractCalendarImage(calHtml);
const augImg = extractCalendarImage(nextHtml);
console.log("calendar.html image:", julyImg);
console.log("calendar-next.html image:", augImg);

const images = {};
for (const [label, url] of [
	["july", julyImg],
	["august", augImg],
]) {
	if (!url) continue;
	const dest = path.join(OUT, `${label}.png`);
	try {
		const n = await download(url, dest);
		images[label] = { url, dest, bytes: n };
		console.log("downloaded", label, n, "bytes");
	} catch (e) {
		console.warn("download fail", label, e.message);
	}
}

const musicSlots = parseMusicHtml(musicHtml, YEAR);
fs.writeFileSync(path.join(OUT, "slots-from-music.json"), JSON.stringify(musicSlots, null, 2));
console.log("\nmusic.html slots:", musicSlots.length);

// Merge: music.html (prefer) + august fixture for gaps / next month
const augPath = path.join(PACKET, "august-2026-slots.json");
let augSlots = [];
if (fs.existsSync(augPath)) {
	augSlots = JSON.parse(fs.readFileSync(augPath, "utf8")).slots || [];
	console.log("august fixture slots:", augSlots.length);
}

const byKey = new Map();
for (const s of musicSlots) {
	byKey.set(`${s.date}|${s.start}`, { ...s, source: s.source || "music.html" });
}
// Fill from august fixture only when date not already covered that day from music,
// or always add if music doesn't have that date
const musicDates = new Set(musicSlots.map((s) => s.date));
for (const s of augSlots) {
	const k = `${s.date}|${s.start}`;
	if (!byKey.has(k)) {
		byKey.set(k, { ...s, source: s.source || "august-fixture" });
	}
}

const merged = [...byKey.values()].sort(
	(a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start),
);

const mergedPath = path.join(PACKET, "slots-merged.json");
fs.writeFileSync(
	mergedPath,
	JSON.stringify(
		{
			generated_at: new Date().toISOString(),
			year: YEAR,
			sources: {
				calendar: CALENDAR,
				calendar_next: CALENDAR_NEXT,
				music: MUSIC,
				images,
			},
			music_slot_count: musicSlots.length,
			august_fixture_count: augSlots.length,
			merged_count: merged.length,
			music_dates: [...musicDates].sort(),
			slots: merged,
		},
		null,
		2,
	),
);

const manifest = {
	generated_at: new Date().toISOString(),
	calendar_page: CALENDAR,
	calendar_next_page: CALENDAR_NEXT,
	music_page: MUSIC,
	images,
	music_slots: musicSlots.length,
	merged_slots: merged.length,
	merged_path: mergedPath,
};
fs.writeFileSync(path.join(OUT, "scrape-manifest.json"), JSON.stringify(manifest, null, 2));

console.log("\nmerged slots:", merged.length);
console.log("wrote", mergedPath);
// Preview upcoming from today
const today = new Date().toISOString().slice(0, 10);
const upcoming = merged.filter((s) => s.date >= today);
console.log("upcoming from", today, ":", upcoming.length);
for (const s of upcoming.slice(0, 15)) {
	console.log(" ", s.date, s.start, s.title, s.source || "");
}
if (upcoming.length > 15) console.log("  …", upcoming.length - 15, "more");
