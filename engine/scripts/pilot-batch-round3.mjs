/**
 * Pilot round 3 — diverse unpiloted venues:
 * ACL Live, Cactus Cafe, Coupland Dancehall, Moontower Saloon,
 * Vulcan Gas Company, Celis Brewery
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
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MONTHS = {
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
	jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
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
async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
		redirect: "follow",
		signal: AbortSignal.timeout(25000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
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
	return `${openers[i % openers.length]} Austin live music energy and a night worth showing up early for. Showtime around ${time}. Grab tickets and get there early.`;
}
function futureOnly(events) {
	const cutoff = Date.now() - 864e5;
	return events.filter((e) => +new Date(e.starts_at) >= cutoff);
}
function dedupe(events) {
	const seen = new Set();
	const out = [];
	for (const e of events) {
		const k = e.source_event_id || `${e.title}|${e.starts_at}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(e);
	}
	return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
function parseTime12(t, fallback = "20:00") {
	const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*([ap]m)/i);
	if (!m) return fallback;
	let h = +m[1];
	const min = m[2];
	const ap = m[3].toLowerCase();
	if (ap === "pm" && h < 12) h += 12;
	if (ap === "am" && h === 12) h = 0;
	return `${String(h).padStart(2, "0")}:${min}`;
}

async function stage(slug, platform, calendarUrl, websiteUrl, events, venueLabel) {
	const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
	const { data: venue } = await sb
		.from("venues")
		.select("id, name")
		.eq("site_id", site.id)
		.eq("slug", slug)
		.maybeSingle();
	if (!venue) {
		console.log(`SKIP missing venue ${slug}`);
		return 0;
	}
	if (!events.length) {
		console.log(`\n=== ${venue.name} === no events`);
		return 0;
	}

	const updates = { calendar_url: calendarUrl };
	if (websiteUrl) updates.website_url = websiteUrl;
	await sb.from("venues").update(updates).eq("id", venue.id);

	const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
	if (sources?.[0]) {
		await sb
			.from("venue_event_sources")
			.update({
				platform_type: platform,
				feed_url: calendarUrl,
				calendar_url: calendarUrl,
				updated_at: new Date().toISOString(),
			})
			.eq("id", sources[0].id);
	} else {
		await sb.from("venue_event_sources").insert({
			venue_id: venue.id,
			platform_type: platform,
			feed_url: calendarUrl,
			calendar_url: calendarUrl,
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

	const venueName = venueLabel || venue.name;
	const rows = events.map((e, i) => {
		const band = (e.band || e.title.split(/[:–|]/)[0] || e.title).trim();
		const desc = e.description || hype(band, venueName, e.starts_at, i);
		return {
			ingestion_run_id: run.id,
			venue_id: venue.id,
			raw_title: e.title,
			raw_date_text: e.raw_date_text ?? null,
			parsed_starts_at: e.starts_at,
			parsed_ends_at: null,
			source_url: e.source_url,
			source_event_id: e.source_event_id,
			fingerprint: fp(e.title, e.starts_at, e.ticket_url),
			source_partner: platform,
			extracted_band_name: band,
			matched_artist_id: null,
			artist_match_status: "unmatched",
			match_status: "new",
			matched_event_id: null,
			review_status: "pending",
			raw_payload: {
				description: desc,
				event_intro: desc,
				price_text: e.price_text ?? null,
				ticket_url: e.ticket_url ?? e.source_url,
				image_url: e.image_url ?? null,
				confidence: e.confidence ?? 0.88,
				import_method: "feed",
				platform,
			},
		};
	});

	for (let i = 0; i < rows.length; i += 40) {
		const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
		if (error) throw new Error(`${slug}: ${error.message}`);
	}

	const imgs = rows.filter((r) => r.raw_payload.image_url).length;
	console.log(`\n=== ${venue.name} === staged ${rows.length} images ${imgs}`);
	for (const e of events.slice(0, 5)) {
		console.log(
			" ",
			new Date(e.starts_at).toLocaleString("en-US", {
				timeZone: TZ,
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			}),
			e.title.slice(0, 52),
			e.image_url ? "🖼" : "·",
		);
	}
	return rows.length;
}

// ───────── ACL Live ─────────
async function parseAclLive() {
	const months = [
		["2026", "July"],
		["2026", "August"],
		["2026", "September"],
		["2026", "October"],
		["2026", "November"],
		["2026", "December"],
		["2027", "January"],
		["2027", "February"],
		["2027", "March"],
		["2027", "April"],
	];
	const events = [];
	const seen = new Set();
	for (const [year, month] of months) {
		let html;
		try {
			html = await get(`https://www.acllive.com/events/filtered/${year}/${month}`);
		} catch {
			continue;
		}
		// card: href + title + optional img nearby
		const cards = [
			...html.matchAll(
				/<a href="https?:\/\/www\.acllive\.com(\/event\/[^"]+)"[^>]*title="More Info for ([^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi,
			),
		];
		// also without img first
		const hrefs = [...html.matchAll(/href="https?:\/\/www\.acllive\.com(\/event\/[^"]+)"[^>]*title="More Info for ([^"]+)"/gi)];
		const pairs = cards.length ? cards : hrefs;
		for (const m of pairs) {
			const path = m[1];
			if (seen.has(path)) continue;
			seen.add(path);
			const title = stripHtml(m[2]);
			if (/premium pass|pnc hall/i.test(title)) continue;
			const img = m[3] || null;
			// path forms:
			// /event/2026-07-11-the-english-channels-at-8-pm
			// /event/acltaping-sienna-spiro-071526
			let date = null;
			let time = "20:00";
			const iso = path.match(/\/event\/(\d{4})-(\d{2})-(\d{2})-(.+?)(?:-at-(\d{1,2})-(\d{2})-?(am|pm))?$/i);
			if (iso) {
				date = `${iso[1]}-${iso[2]}-${iso[3]}`;
				if (iso[5] && iso[6]) {
					time = parseTime12(`${iso[5]}:${iso[6]} ${iso[7] || "pm"}`);
				}
			} else {
				const mdY = path.match(/(\d{2})(\d{2})(\d{2})$/);
				if (mdY) {
					const yy = +mdY[3] < 50 ? 2000 + +mdY[3] : 1900 + +mdY[3];
					date = `${yy}-${mdY[1]}-${mdY[2]}`;
				}
			}
			if (!date) continue;
			const starts_at = localToUtc(`${date} ${time}:00`);
			events.push({
				title,
				band: title,
				starts_at,
				image_url: img,
				source_url: `https://www.acllive.com${path}`,
				source_event_id: path,
				raw_date_text: `${date} ${time}`,
				ticket_url: `https://www.acllive.com${path}`,
				confidence: 0.92,
			});
		}
	}
	return dedupe(futureOnly(events));
}

// ───────── Cactus Cafe (UT Unions paginated listing) ─────────
async function parseCactus() {
	const ORIGIN = "https://universityunions.utexas.edu";
	const absImage = (src) => {
		if (!src) return null;
		let path = src;
		const m = path.match(/\/styles\/[^/]+\/public\/(.+?)(?:\?|$)/i);
		if (m) path = `/sites/default/files/${m[1]}`;
		path = path.split("?")[0];
		if (path.startsWith("http")) return path;
		return `${ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
	};
	const isCactus = (title, path) =>
		/cactus\s*cafe|live at the cactus|at the cactus cafe|cactus-cafe/i.test(`${title} ${path}`);

	const byPath = new Map();
	for (let page = 0; page <= 3; page++) {
		const url = page === 0 ? `${ORIGIN}/events` : `${ORIGIN}/events?page=${page}`;
		let html;
		try {
			html = await get(url);
		} catch {
			continue;
		}
		const cards = [
			...html.matchAll(
				/<img[^>]+src="(\/sites\/default\/files\/[^"]+)"[^>]*>[\s\S]{0,2000}?href="(\/events\/[^"?#]+)"[^>]*>([^<]{3,160})</gi,
			),
		];
		for (const m of cards) {
			const path = m[2];
			const title = stripHtml(m[3]);
			if (!title || !isCactus(title, path) || byPath.has(path)) continue;
			const start = Math.max(0, m.index - 400);
			const window = html.slice(start, m.index + m[0].length + 800);
			const iso = window.match(/datetime="(\d{4}-\d{2}-\d{2})/i)?.[1];
			const long = window.match(
				/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
			);
			let date = iso;
			if (!date && long) {
				const mo = MONTHS[long[1].toLowerCase()];
				date = `${long[3]}-${String(mo).padStart(2, "0")}-${String(+long[2]).padStart(2, "0")}`;
			}
			byPath.set(path, { path, title, date, image_url: absImage(m[1]) });
		}
	}

	const events = [];
	for (const it of byPath.values()) {
		let { date, image_url } = it;
		let time = "19:30";
		let description = null;
		try {
			const detail = await get(`${ORIGIN}${it.path}`);
			if (!date) {
				const iso = detail.match(/datetime="(\d{4}-\d{2}-\d{2})/i)?.[1];
				const long = detail.match(
					/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
				);
				if (iso) date = iso;
				else if (long) {
					const mo = MONTHS[long[1].toLowerCase()];
					date = `${long[3]}-${String(mo).padStart(2, "0")}-${String(+long[2]).padStart(2, "0")}`;
				}
			}
			const t = detail.match(/(\d{1,2}:\d{2}\s*[ap]m)/i)?.[1];
			if (t) time = parseTime12(t, "19:30");
			if (!image_url) {
				const og =
					detail.match(/property=["']og:image["']\s+content=["']([^"']+)/i)?.[1] ||
					detail.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i)?.[1];
				image_url = og?.startsWith("http") ? og : og ? `${ORIGIN}${og}` : null;
			}
			const body = detail.match(
				/<div[^>]*class="[^"]*field--name-body[^"]*"[^>]*>([\s\S]{40,800}?)<\/div>/i,
			);
			if (body) {
				const d = stripHtml(body[1]);
				if (d.length > 40) description = d.slice(0, 600);
			}
		} catch {
			/* keep defaults */
		}
		if (!date) continue;
		const band = it.title
			.replace(/\s*Live at The Cactus Cafe!?\s*/i, "")
			.replace(/\s*at The Cactus Cafe!?\s*/i, "")
			.trim();
		events.push({
			title: it.title,
			band: band || it.title,
			starts_at: localToUtc(`${date} ${time}:00`),
			image_url,
			source_url: `${ORIGIN}${it.path}`,
			source_event_id: it.path,
			raw_date_text: `${date} ${time}`,
			ticket_url: `${ORIGIN}${it.path}`,
			description,
			confidence: 0.91,
		});
	}
	return dedupe(futureOnly(events));
}

// ───────── Coupland Dancehall ─────────
async function parseCoupland() {
	const html = await get("https://www.couplanddancehall.com/shows");
	const events = [];
	const seen = new Set();
	const yearNow = new Date().getFullYear();

	// Poster → title → date → etix (Squarespace data-image on /shows)
	const re =
		/data-image="(https:\/\/images\.squarespace-cdn\.com\/content\/v1\/[^"]+)"[\s\S]{0,5000}?<h2[^>]*>\s*<strong>\s*([^<]+)\s*<\/strong>[\s\S]{0,2000}?(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),\s*(?:(\d{1,2})\/(\d{1,2})\/(\d{2})|([A-Z]+)\s+(\d{1,2})(?:ST|ND|RD|TH)?)[\s\S]{0,1500}?href="(https:\/\/(?:www\.)?etix\.com\/ticket\/p\/(\d+)\/[^"]+)"/gi;

	for (const m of html.matchAll(re)) {
		const image_url = (m[1] || "").split("?")[0];
		const title = titleCase(stripHtml(m[2]));
		const ticket = m[8];
		const id = m[9];
		if (!title || seen.has(id)) continue;
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

		const doorsWin = html.slice(m.index, m.index + 2000);
		const doors = doorsWin.match(/Doors?\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i)?.[1];
		let time = "19:00";
		if (doors) {
			const t = doors.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
			if (t) time = parseTime12(`${t[1]}:${t[2] || "00"} ${t[3]}`, "19:00");
		}

		events.push({
			title,
			band: title,
			starts_at: localToUtc(`${date} ${time}:00`),
			image_url,
			source_url: ticket,
			source_event_id: `etix-${id}`,
			raw_date_text: date,
			ticket_url: ticket,
			confidence: 0.92,
		});
	}
	return dedupe(futureOnly(events));
}

// ───────── Moontower Saloon ─────────
async function parseMoontower() {
	const html = await get("https://moontowersaloon.com/austin-menchaca-moontower-saloon-events");
	const events = [];
	// addtocalendar blocks carry start + title
	const blocks = [
		...html.matchAll(
			/<var class="atc_date_start">(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})<\/var>[\s\S]{0,400}?<var class="atc_title">([^<]+)<\/var>/gi,
		),
	];
	const seen = new Set();
	for (const m of blocks) {
		const date = m[1];
		const time = m[2].slice(0, 5);
		const title = stripHtml(m[3]);
		const key = `${title}|${date}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// skip pure holiday/food days without music cue — keep if not only "National X Day"
		const isNationalOnly = /^National\s+.+\s+Day$/i.test(title) || /^(Labor Day|Memorial Day)$/i.test(title);
		// check nearby for LIVE MUSIC marker
		const start = Math.max(0, m.index - 800);
		const window = html.slice(start, m.index + 200);
		const liveMusic = /LIVE MUSIC/i.test(window);
		if (isNationalOnly && !liveMusic) continue;
		if (/karaoke/i.test(title) && !liveMusic) {
			// keep karaoke as nightlife
		}
		const starts_at = localToUtc(`${date} ${time}:00`);
		const eid = window.match(/data-event-id="(\d+)"/)?.[1] || key;
		events.push({
			title,
			band: title,
			starts_at,
			source_url: "https://moontowersaloon.com/austin-menchaca-moontower-saloon-events",
			source_event_id: `moontower-${eid}`,
			raw_date_text: `${date} ${time}`,
			ticket_url: "https://moontowersaloon.com/austin-menchaca-moontower-saloon-events",
			confidence: 0.86,
		});
	}
	// fallback: data-event-id + heading + date text
	if (events.length < 3) {
		const re =
			/data-event-id="(\d+)"[\s\S]{0,1200}?<h3[^>]*class="event-time"[^>]*>(\d{1,2}:\d{2}\s*[AP]M)[\s\S]{0,200}?atc_date_start">(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/gi;
		// simpler heading approach
		const loose = [
			...html.matchAll(
				/<h3[^>]*>([^<]{2,80})<\/h3>[\s\S]{0,200}?(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[\s\S]{0,400}?(\d{1,2}:\d{2}\s*[AP]M)/gi,
			),
		];
		const year = new Date().getFullYear();
		for (const m of loose) {
			const title = stripHtml(m[1]);
			if (/^Events$|Gallery|Reviews|National\s+/i.test(title)) continue;
			const mo = MONTHS[m[3].toLowerCase()];
			const dd = String(+m[4]).padStart(2, "0");
			// assume current/next year
			let y = year;
			const tentative = new Date(y, mo - 1, +m[4]);
			if (tentative < new Date(Date.now() - 7 * 864e5)) y = year; // still this year if recent
			// if month already passed far, next year
			if (mo < new Date().getMonth() + 1 - 1 && tentative < new Date()) y = year; // keep
			const date = `${y}-${String(mo).padStart(2, "0")}-${dd}`;
			const time = parseTime12(m[5], "20:00");
			const key = `${title}|${date}`;
			if (seen.has(key)) continue;
			seen.add(key);
			events.push({
				title,
				band: title,
				starts_at: localToUtc(`${date} ${time}:00`),
				source_url: "https://moontowersaloon.com/austin-menchaca-moontower-saloon-events",
				source_event_id: key,
				raw_date_text: `${m[2]} ${m[3]} ${m[4]} ${m[5]}`,
				ticket_url: "https://moontowersaloon.com/austin-menchaca-moontower-saloon-events",
				confidence: 0.82,
			});
		}
	}
	return dedupe(futureOnly(events));
}

// ───────── Vulcan Gas Company ─────────
async function parseVulcan() {
	const html = await get("https://vulcanatx.com/");
	const events = [];
	// Webflow collection items
	const re =
		/<div class="event-month">([A-Za-z]{3})<\/div>\s*<div class="event-date">(\d{1,2})<\/div>[\s\S]{0,400}?<div class="event-name">([^<]+)<\/div>[\s\S]{0,300}?<div class="event-time">([^<]+)<\/div>[\s\S]{0,800}?href="(https?:\/\/[^"]+)"/gi;
	const yearNow = new Date().getFullYear();
	const monthNow = new Date().getMonth() + 1;
	const seen = new Set();
	for (const m of html.matchAll(re)) {
		const mon = MONTHS[m[1].toLowerCase()];
		if (!mon) continue;
		const day = +m[2];
		// year rollover: if month is far before current month, next year
		let year = yearNow;
		if (mon < monthNow - 1) year = yearNow + 1;
		// if we're late in year and mon is early, next year
		if (monthNow >= 11 && mon <= 2) year = yearNow + 1;
		const date = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		const title = stripHtml(m[3]);
		const time = parseTime12(m[4], "22:00");
		const href = m[5];
		if (!title || href === "#" || /private-event/i.test(href + title)) continue;
		// skip non-ticket CTAs
		if (!/etix|dice|ticketsauce|sdpresents|ticket/i.test(href) && href.startsWith("http") === false) continue;
		if (!/etix|dice|ticketsauce|sdpresents|ticket|event/i.test(href)) {
			// might be rsvp # — still keep with homepage source
		}
		const key = `${title}|${date}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// image near event
		const start = Math.max(0, m.index - 1500);
		const window = html.slice(start, m.index + 100);
		const image_url =
			window.match(/src="(https:\/\/cdn\.prod\.website-files\.com\/[^"]+)"/i)?.[1] ||
			window.match(/src="(https:\/\/uploads-ssl\.webflow\.com\/[^"]+)"/i)?.[1] ||
			null;
		const ticket_url = /etix|dice|ticketsauce|sdpresents/i.test(href) ? href : "https://vulcanatx.com/";
		events.push({
			title,
			band: title,
			starts_at: localToUtc(`${date} ${time}:00`),
			image_url,
			source_url: ticket_url,
			source_event_id: key,
			raw_date_text: `${m[1]} ${m[2]} ${m[4]}`,
			ticket_url,
			confidence: 0.88,
		});
	}
	return dedupe(futureOnly(events));
}

// ───────── Celis Brewery ─────────
async function parseCelis() {
	const html = await get("https://celisbeers.com/events");
	const events = [];
	const pairs = [
		...html.matchAll(/"startDate":"(\d{4}-\d{2}-\d{2}T[^"]+)"[^]{0,600}?"title":"([^"\\]{3,80})"/g),
	];
	const seen = new Set();
	const slugMap = Object.fromEntries(
		[...html.matchAll(/event-details\/([a-z0-9%-]+)/gi)].map((m) => [m[1].replace(/-/g, " ").toLowerCase(), m[1]]),
	);
	for (const m of pairs) {
		const title = stripHtml(m[2].replace(/\\u0026/g, "&").replace(/\\"/g, '"'));
		if (/\{title\}|button|menu|null|undefined|page|subscribe|team/i.test(title)) continue;
		const startRaw = m[1];
		// Wix times often UTC — convert carefully
		const iso = new Date(startRaw);
		if (Number.isNaN(+iso)) continue;
		// if midnight UTC trivia, treat as evening CT previous calendar day sometimes wrong — use as-is for now
		const starts_at = iso.toISOString();
		const key = `${title}|${starts_at.slice(0, 16)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// find matching slug
		const slugKey = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
		let slug = null;
		for (const [k, v] of Object.entries(slugMap)) {
			if (slugKey.includes(k.slice(0, 12)) || k.includes(slugKey.slice(0, 12))) {
				slug = v;
				break;
			}
		}
		const source_url = slug
			? `https://celisbeers.com/event-details/${slug}`
			: "https://celisbeers.com/events";
		// image near title in HTML
		const tIdx = html.indexOf(title);
		let image_url = null;
		if (tIdx > 0) {
			const window = html.slice(Math.max(0, tIdx - 2000), tIdx + 200);
			image_url = window.match(/https:\/\/static\.wixstatic\.com\/media\/[^"\\\s]+/)?.[0] || null;
		}
		events.push({
			title,
			band: title,
			starts_at,
			image_url,
			source_url,
			source_event_id: slug || key,
			raw_date_text: startRaw,
			ticket_url: source_url,
			confidence: 0.84,
		});
	}
	return dedupe(futureOnly(events));
}

// ───────── Run all ─────────
const results = [];

try {
	const acl = await parseAclLive();
	results.push(["acl-live", await stage("acl-live", "axs", "https://www.acllive.com/events", "https://www.acllive.com/", acl, "ACL Live")]);
} catch (e) {
	console.log("ACL Live ERR", e.message);
}

try {
	const cactus = await parseCactus();
	results.push([
		"cactus-cafe",
		await stage("cactus-cafe", "drupal_events", "https://cactuscafe.org/events", "https://cactuscafe.org/", cactus, "Cactus Cafe"),
	]);
} catch (e) {
	console.log("Cactus ERR", e.message);
}

try {
	const coup = await parseCoupland();
	results.push([
		"coupland-dancehall",
		await stage(
			"coupland-dancehall",
			"etix",
			"https://www.couplanddancehall.com/shows",
			"https://www.couplanddancehall.com/",
			coup,
			"Coupland Dancehall",
		),
	]);
} catch (e) {
	console.log("Coupland ERR", e.message);
}

try {
	const moon = await parseMoontower();
	results.push([
		"moontower-saloon",
		await stage(
			"moontower-saloon",
			"html_calendar",
			"https://moontowersaloon.com/austin-menchaca-moontower-saloon-events",
			"https://moontowersaloon.com/",
			moon,
			"Moontower Saloon",
		),
	]);
} catch (e) {
	console.log("Moontower ERR", e.message);
}

try {
	const vulcan = await parseVulcan();
	results.push([
		"vulcan-gas-company",
		await stage("vulcan-gas-company", "webflow", "https://vulcanatx.com/", "https://vulcanatx.com/", vulcan, "Vulcan Gas Company"),
	]);
} catch (e) {
	console.log("Vulcan ERR", e.message);
}

try {
	const celis = await parseCelis();
	results.push([
		"celis-brewery",
		await stage("celis-brewery", "wix_events", "https://celisbeers.com/events", "https://celisbeers.com/", celis, "Celis Brewery"),
	]);
} catch (e) {
	console.log("Celis ERR", e.message);
}

console.log("\n──── Summary ────");
for (const [slug, n] of results) console.log(`  ${String(n).padStart(3)}  ${slug}`);
console.log("\nDone → https://events-platform-admin.ben-745.workers.dev/ingestion");
