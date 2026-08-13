/**
 * Full Cactus Cafe pilot from UT Unions paginated listing.
 * Pages: /events, /events?page=1, /events?page=2
 * Images: /sites/default/files/styles/.../public/...
 * Dates: "July 29, 7:30 to 9:30 p.m." in views-field-field-utevent-datetime
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
const ORIGIN = "https://universityunions.utexas.edu";
const CAL = `${ORIGIN}/events`;

const MONTHS = {
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
	jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
	oct: 10, nov: 11, dec: 12,
};
const MONTH_RE =
	"(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?";

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
		.replace(/&#039;|&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Prefer real event copy; reject generic UT Unions mission blurb. */
function isJunkDescription(text) {
	if (!text || text.length < 20) return true;
	return /mission of the University Unions|enhance the student experience and to enrich campus life/i.test(
		text,
	);
}

/** Extract field-utevent-body (listing teaser or detail bio). */
function extractUteventBody(html) {
	const patterns = [
		// Detail: field--name-field-utevent-body ... field__item > content
		/field--name-field-utevent-body[\s\S]{0,300}?field__item[^>]*>([\s\S]{15,4000}?)<\/div>\s*<\/div>/i,
		// Listing views: views-field-field-utevent-body ... field-content
		/views-field-field-utevent-body[\s\S]{0,200}?<div class="field-content">([\s\S]{10,800}?)<\/div>/i,
		// Class utevent-event-field--field-utevent-body
		/utevent-event-field--field-utevent-body[^>]*>([\s\S]{15,4000}?)<\/div>\s*<\/div>/i,
	];
	for (const re of patterns) {
		const m = html.match(re);
		if (!m) continue;
		const text = stripHtml(m[1]);
		if (!isJunkDescription(text)) return text.slice(0, 1200);
	}
	return null;
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
	return `${openers[i % openers.length]} Intimate campus-venue energy at UT's historic Cactus Cafe. Showtime around ${time}. Grab tickets and get there early.`;
}
function parseTime12(t, fallback = "19:30") {
	const m = String(t || "").match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
	if (!m) return fallback;
	let h = +m[1];
	const min = m[2] || "00";
	const ap = m[3].toLowerCase();
	if (ap === "p" && h < 12) h += 12;
	if (ap === "a" && h === 12) h = 0;
	return `${String(h).padStart(2, "0")}:${min}`;
}
function absImage(src) {
	if (!src) return null;
	let path = src;
	const m = path.match(/\/styles\/[^/]+\/public\/(.+?)(?:\?|$)/i);
	if (m) path = `/sites/default/files/${m[1]}`;
	path = path.split("?")[0];
	if (path.startsWith("http")) return path;
	return `${ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}
function isCactus(title, path, location) {
	const loc = (location || "").toLowerCase();
	// Prefer explicit location field
	if (loc && /cactus\s*cafe/i.test(loc)) return true;
	if (loc && loc.length > 1 && !/cactus/i.test(loc)) return false;
	const hay = `${title} ${path}`.toLowerCase();
	return /cactus\s*cafe|live at the cactus|at the cactus cafe|cactus-cafe/i.test(hay);
}

/** Parse "July 29, 7:30 to 9:30 p.m." / "Aug. 1, 7:30 p.m." / "July 29, 2026" */
function parseListingDateTime(text, yearHint) {
	const raw = stripHtml(text);
	// Month DD, YYYY ... optional time
	let m = raw.match(
		new RegExp(
			`${MONTH_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})(?:[,\\s]+(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?)?`,
			"i",
		),
	);
	if (m) {
		const mo = MONTHS[m[1].toLowerCase().replace(/\.$/, "")];
		if (!mo) return null;
		const date = `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
		let time = "19:30";
		if (m[4]) time = parseTime12(`${m[4]}:${m[5] || "00"} ${m[6]}m`, "19:30");
		return { date, time, raw };
	}
	// Month DD, H:MM to H:MM p.m.  OR Month DD, H:MM p.m. (no year)
	m = raw.match(
		new RegExp(
			`${MONTH_RE}\\s+(\\d{1,2}),?\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(?:to\\s+\\d{1,2}(?::\\d{2})?\\s*)?([ap])\\.?m\\.?`,
			"i",
		),
	);
	if (m) {
		const mo = MONTHS[m[1].toLowerCase().replace(/\.$/, "")];
		if (!mo) return null;
		const year = yearHint || new Date().getFullYear();
		const date = `${year}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
		const time = parseTime12(`${m[3]}:${m[4] || "00"} ${m[5]}m`, "19:30");
		return { date, time, raw };
	}
	// Month DD, YYYY only (already covered) or Month DD only
	m = raw.match(new RegExp(`${MONTH_RE}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?`, "i"));
	if (m) {
		const mo = MONTHS[m[1].toLowerCase().replace(/\.$/, "")];
		if (!mo) return null;
		const year = m[3] ? +m[3] : yearHint || new Date().getFullYear();
		const date = `${year}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
		return { date, time: "19:30", raw };
	}
	return null;
}

async function get(url) {
	const r = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml",
		},
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

function parseViewsRows(html) {
	const chunks = html.split(/class="[^"]*views-row[^"]*"/i).slice(1);
	const items = [];
	for (const row of chunks) {
		// stop at next major section if needed — row is already split
		const titleM = row.match(/href="(\/events\/[^"?#]+)"[^>]*>([^<]{3,160})</i);
		if (!titleM) continue;
		const path = titleM[1];
		const title = stripHtml(titleM[2]);
		const img = row.match(/src="(\/sites\/default\/files\/[^"]+)"/i)?.[1];
		const location = stripHtml(
			row.match(/views-field-field-utevent-location[\s\S]{0,400}?location-icon[^>]*>[\s\S]*?<\/span>\s*([^<]+)/i)?.[1] ||
				row.match(/Location:<\/span>[^<]*<\/span>\s*([^<]+)/i)?.[1] ||
				"",
		);
		// Capture full datetime text including abbreviated months (Aug. 1, 7:30 p.m.)
		const dateField =
			row.match(
				/views-field-field-utevent-datetime[\s\S]{0,800}?<\/div>\s*<\/div>/i,
			)?.[0] ||
			row.match(/Date and time:[\s\S]{0,300}/i)?.[0] ||
			"";
		const body = extractUteventBody(row) || "";
		// year hint from image path /2026-06/
		const yearHint = img?.match(/\/(20\d{2})-\d{2}\//)?.[1]
			? Number(img.match(/\/(20\d{2})-\d{2}\//)[1])
			: null;

		items.push({
			path,
			title,
			image_url: absImage(img),
			location,
			dateField,
			body,
			yearHint,
		});
	}
	return items;
}

const byPath = new Map();
for (let page = 0; page <= 3; page++) {
	const url = page === 0 ? CAL : `${CAL}?page=${page}`;
	try {
		const html = await get(url);
		const items = parseViewsRows(html);
		const cactus = items.filter((it) => isCactus(it.title, it.path, it.location));
		console.log(`page ${page}: ${items.length} rows, ${cactus.length} cactus`);
		for (const it of cactus) {
			if (!byPath.has(it.path)) byPath.set(it.path, it);
		}
		if (page > 0 && items.length === 0) break;
	} catch (e) {
		console.log(`page ${page} ERR`, e.message);
	}
}

console.log(`unique cactus: ${byPath.size}`);

const events = [];
for (const it of byPath.values()) {
	let parsed = parseListingDateTime(it.dateField, it.yearHint || new Date().getFullYear());
	let description = it.body || null;
	let image_url = it.image_url;

	// Detail page: fill year/time/description; prefer listing date when present
	// (detail pages sometimes include past occurrence dates that confuse parsers)
	try {
		const detail = await get(`${ORIGIN}${it.path}`);
		const detailDate =
			detail.match(
				new RegExp(`${MONTH_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"),
			)?.[0] ||
			detail.match(/datetime="(\d{4}-\d{2}-\d{2}[^"]*)"/i)?.[1] ||
			"";
		const detailTime = detail.match(/(\d{1,2}:\d{2}\s*[ap]\.?m\.?)/i)?.[1];
		if (!parsed && detailDate) {
			const dParsed = parseListingDateTime(
				`${detailDate}${detailTime ? ` ${detailTime}` : ""}`,
				it.yearHint,
			);
			if (dParsed) {
				// If CMS detail year is in the past, re-parse with current/yearHint year
				if (+new Date(dParsed.date) < Date.now() - 864e5) {
					const md = dParsed.date.slice(5); // MM-DD
					const y = it.yearHint || new Date().getFullYear();
					const fixed = `${y}-${md}`;
					if (+new Date(fixed) >= Date.now() - 864e5) {
						parsed = { ...dParsed, date: fixed };
					} else {
						parsed = dParsed;
					}
				} else {
					parsed = dParsed;
				}
			}
		} else if (parsed && detailDate) {
			// adopt detail year only when it keeps the event upcoming (avoid stale CMS years)
			const dParsed = parseListingDateTime(detailDate, it.yearHint);
			if (
				dParsed &&
				dParsed.date.slice(5) === parsed.date.slice(5) &&
				+new Date(dParsed.date) >= Date.now() - 864e5
			) {
				parsed = { ...parsed, date: dParsed.date };
			}
		}
		if (parsed && detailTime) parsed.time = parseTime12(detailTime, parsed.time);
		const showAt = (detail + " " + (it.body || "")).match(
			/Show at\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i,
		)?.[1];
		if (showAt && parsed) parsed.time = parseTime12(showAt, parsed.time);

		if (!image_url) {
			const og =
				detail.match(/property=["']og:image["']\s+content=["']([^"']+)/i)?.[1] ||
				detail.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i)?.[1];
			if (og) image_url = og.startsWith("http") ? og : `${ORIGIN}${og}`;
		}
		// Detail field-utevent-body has full artist/event copy (not the generic field--name-body mission)
		const detailBody = extractUteventBody(detail);
		if (detailBody) {
			// Prefer longer detail bio; keep listing teaser if detail is short/doors-only
			const listingIsDoorsOnly = /^doors?\s+at/i.test(description || "") || (description || "").length < 80;
			if (!description || listingIsDoorsOnly || detailBody.length > description.length) {
				description = detailBody;
			}
		}
	} catch (e) {
		console.log("detail fail", it.path, e.message);
	}

	if (!parsed?.date) {
		console.log("skip no date", it.title.slice(0, 50), "field:", stripHtml(it.dateField).slice(0, 60));
		continue;
	}

	// Repair only clearly stale CMS years (e.g. open mic still stamped 2023)
	let starts_at = localToUtc(`${parsed.date} ${parsed.time || "19:30"}:00`);
	const eventYear = +parsed.date.slice(0, 4);
	const thisYear = new Date().getFullYear();
	if (+new Date(starts_at) < Date.now() - 864e5 && eventYear < thisYear) {
		const md = parsed.date.slice(5);
		const tryDate = `${thisYear}-${md}`;
		const tryStart = localToUtc(`${tryDate} ${parsed.time || "19:30"}:00`);
		if (+new Date(tryStart) >= Date.now() - 864e5) {
			parsed = { ...parsed, date: tryDate };
			starts_at = tryStart;
		}
	}
	if (+new Date(starts_at) < Date.now() - 864e5) {
		console.log("skip past", parsed.date, it.title.slice(0, 40));
		continue;
	}

	const band = it.title
		.replace(/\s*Live at The Cactus Cafe!?\s*/i, "")
		.replace(/\s*at The Cactus Cafe!?\s*/i, "")
		.replace(/\s*Live at Cactus Cafe!?\s*/i, "")
		.trim();

	events.push({
		title: it.title,
		band: band || it.title,
		starts_at,
		image_url,
		source_url: `${ORIGIN}${it.path}`,
		source_event_id: it.path,
		raw_date_text: parsed.raw || `${parsed.date} ${parsed.time}`,
		ticket_url: `${ORIGIN}${it.path}`,
		description,
		confidence: 0.92,
	});
}

events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
const uniq = [];
const seen = new Set();
for (const e of events) {
	if (seen.has(e.source_event_id)) continue;
	seen.add(e.source_event_id);
	uniq.push(e);
}

console.log(
	`\nReady: ${uniq.length} images ${uniq.filter((e) => e.image_url).length} descs ${uniq.filter((e) => e.description).length}`,
);
for (const e of uniq) {
	const file = decodeURIComponent((e.image_url || "").split("/").pop() || "").slice(0, 28);
	console.log(
		" ",
		new Date(e.starts_at).toLocaleString("en-US", {
			timeZone: TZ,
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}),
		e.title.slice(0, 36).padEnd(36),
		file,
	);
	if (e.description) console.log("    desc:", e.description.slice(0, 100).replace(/\n/g, " "));
	else console.log("    desc: (hype fallback)");
}

if (!uniq.length) {
	console.error("No events");
	process.exit(1);
}

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id, name")
	.eq("site_id", site.id)
	.eq("slug", "cactus-cafe")
	.single();

await sb
	.from("venues")
	.update({ calendar_url: CAL, website_url: "https://cactuscafe.org/" })
	.eq("id", venue.id);

const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({
			platform_type: "drupal_events",
			feed_url: CAL,
			calendar_url: CAL,
			updated_at: new Date().toISOString(),
		})
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "drupal_events",
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

const venueName = "Cactus Cafe";
const rows = uniq.map((e, i) => {
	const desc = e.description || hype(e.band, venueName, e.starts_at, i);
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
		source_partner: "drupal_events",
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
			platform: "drupal_events",
		},
	};
});

const { error } = await sb.from("ingested_events").insert(rows);
if (error) throw new Error(error.message);

console.log(`\n=== Cactus Cafe === staged ${rows.length} images ${rows.filter((r) => r.raw_payload.image_url).length}`);
console.log("Done → https://events-platform-admin.ben-745.workers.dev/ingestion");
