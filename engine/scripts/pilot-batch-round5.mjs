/**
 * Pilot round 5 — venues with reliable structured calendars:
 * - Guero's Taco Bar (TEC / tribe events API)
 * - Extensible stage() for additional parsers added below
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";

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

function fp(title, starts, ticket) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${ticket ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}
function stripHtml(v) {
	return String(v || "")
		.replace(/&amp;/gi, "&")
		.replace(/&#039;|&#39;|&apos;/gi, "'")
		.replace(/&#8217;/g, "'")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** 12-hour clock for event intros (never "14:30:00" military wall times). */
function formatShowtime12h(startsAtIso, endsAtIso) {
	const opts = {
		timeZone: TZ,
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	};
	const start = new Date(startsAtIso).toLocaleTimeString("en-US", opts);
	if (!endsAtIso) return start;
	const end = new Date(endsAtIso).toLocaleTimeString("en-US", opts);
	if (end === start) return start;
	return `${start} – ${end}`;
}

/** Friendly date for copy, e.g. "Saturday, July 11". */
function formatShowDate(startsAtIso) {
	return new Date(startsAtIso).toLocaleDateString("en-US", {
		timeZone: TZ,
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}

/** Review-UI date line — never store TEC wall times like "2026-07-11 14:30:00". */
function formatRawDateText12h(startsAtIso, endsAtIso) {
	const date = new Date(startsAtIso).toLocaleDateString("en-US", {
		timeZone: TZ,
		weekday: "short",
		month: "short",
		day: "numeric",
	});
	return `${date} · ${formatShowtime12h(startsAtIso, endsAtIso)}`;
}

/** Drop military wall times from venue-provided descriptions. */
function sanitizeDescriptionTimes(text, startsAtIso, endsAtIso) {
	if (!text) return text;
	const showtime = formatShowtime12h(startsAtIso, endsAtIso);
	const showDate = formatShowDate(startsAtIso);
	let out = text;
	out = out.replace(
		/Showtime around \d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?/gi,
		`Showtime around ${showtime}`,
	);
	out = out.replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\b/g, `${showDate} at ${showtime}`);
	out = out.replace(/\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b/g, (_m, h, min) => {
		let hour = Number(h);
		const ap = hour >= 12 ? "PM" : "AM";
		if (hour === 0) hour = 12;
		else if (hour > 12) hour -= 12;
		return `${hour}:${min} ${ap}`;
	});
	return out;
}
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
	const [hh, mm, ss = 0] = (timePart || "20:00:00").split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, +ss));
	return new Date(guess.getTime() - getOffsetMin(TZ, guess) * 60000).toISOString();
}

async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
		redirect: "follow",
		signal: AbortSignal.timeout(25000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

async function rehost(siteId, folder, imageUrl) {
	if (!imageUrl) return null;
	if (/supabase\.co\/storage/i.test(imageUrl)) return imageUrl;
	try {
		const r = await fetch(imageUrl, {
			headers: { "User-Agent": UA, Accept: "image/*,*/*" },
			redirect: "follow",
			signal: AbortSignal.timeout(25000),
		});
		if (!r.ok) return imageUrl;
		const contentType = r.headers.get("content-type") ?? "image/jpeg";
		if (!contentType.startsWith("image/")) return imageUrl;
		const ext = contentType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ?? "jpg";
		const bytes = await r.arrayBuffer();
		const path = `${siteId}/${folder}/${randomUUID()}.${ext}`;
		const { error } = await sb.storage.from("event-media").upload(path, bytes, {
			contentType,
			upsert: false,
		});
		if (error) return imageUrl;
		return sb.storage.from("event-media").getPublicUrl(path).data.publicUrl;
	} catch {
		return imageUrl;
	}
}

async function ensureVenue(siteId, { slug, name, website_url, calendar_url, address, description }) {
	let { data: venue } = await sb
		.from("venues")
		.select("id, name, slug")
		.eq("site_id", siteId)
		.eq("slug", slug)
		.maybeSingle();
	if (venue) {
		await sb
			.from("venues")
			.update({
				calendar_url: calendar_url || undefined,
				website_url: website_url || undefined,
				name: name || undefined,
				updated_at: new Date().toISOString(),
			})
			.eq("id", venue.id);
		return venue;
	}
	// fuzzy match by name
	const { data: byName } = await sb
		.from("venues")
		.select("id, name, slug")
		.eq("site_id", siteId)
		.ilike("name", `%${name.split(" ")[0]}%`)
		.limit(5);
	const fuzzy = (byName || []).find(
		(v) =>
			v.slug.includes(slug.slice(0, 8)) ||
			slug.includes(v.slug.slice(0, 8)) ||
			v.name.toLowerCase().includes(name.toLowerCase().slice(0, 12)),
	);
	if (fuzzy) {
		await sb
			.from("venues")
			.update({
				calendar_url: calendar_url || undefined,
				website_url: website_url || undefined,
				updated_at: new Date().toISOString(),
			})
			.eq("id", fuzzy.id);
		return fuzzy;
	}
	const { data: created, error } = await sb
		.from("venues")
		.insert({
			site_id: siteId,
			slug,
			name,
			website_url: website_url || null,
			calendar_url: calendar_url || null,
			address: address || null,
			description: description || null,
			status: "published",
		})
		.select("id, name, slug")
		.single();
	if (error) throw new Error(`create venue ${slug}: ${error.message}`);
	console.log("created venue", slug);
	return created;
}

async function stage(slug, platform, calendarUrl, websiteUrl, events, venueLabel, extras = {}) {
	const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
	const venue = await ensureVenue(site.id, {
		slug,
		name: venueLabel,
		website_url: websiteUrl,
		calendar_url: calendarUrl,
		address: extras.address,
		description: extras.description,
	});

	if (!events.length) {
		console.log(`\n=== ${venue.name} === no events`);
		return 0;
	}

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
		.insert({
			site_id: site.id,
			venue_id: venue.id,
			status: "success",
			finished_at: new Date().toISOString(),
		})
		.select("id")
		.single();

	const rows = [];
	for (let i = 0; i < events.length; i++) {
		const e = events[i];
		const band = (e.band || e.title.split(/[:–|]/)[0] || e.title).trim();
		const showtime = formatShowtime12h(e.starts_at, e.ends_at);
		const showDate = formatShowDate(e.starts_at);
		const desc = sanitizeDescriptionTimes(
			e.description ||
				`Catch ${band} live at ${venueLabel} on ${showDate}. Showtime around ${showtime}.`.trim(),
			e.starts_at,
			e.ends_at,
		);
		const hosted = e.image_url ? await rehost(site.id, slug.slice(0, 24), e.image_url) : null;
		rows.push({
			ingestion_run_id: run.id,
			venue_id: venue.id,
			raw_title: e.title,
			// Always 12-hour CT for review UI (never TEC "YYYY-MM-DD HH:mm:ss")
			raw_date_text: formatRawDateText12h(e.starts_at, e.ends_at),
			parsed_starts_at: e.starts_at,
			parsed_ends_at: e.ends_at ?? null,
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
				event_intro: desc.slice(0, 400),
				price_text: e.price_text ?? null,
				ticket_url: e.ticket_url ?? e.source_url,
				image_url: hosted,
				source_image_url: e.image_url || null,
				confidence: e.confidence ?? 0.92,
				import_method: "feed",
				platform,
			},
		});
		if ((i + 1) % 10 === 0) console.log(`  rehost ${i + 1}/${events.length}`);
	}

	for (let i = 0; i < rows.length; i += 40) {
		const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
		if (error) throw new Error(`${slug}: ${error.message}`);
	}

	const imgs = rows.filter((r) => r.raw_payload.image_url).length;
	console.log(`\n=== ${venue.name} (${venue.slug}) === staged ${rows.length}  images ${imgs}`);
	for (const e of events.slice(0, 6)) {
		console.log(
			" ",
			new Date(e.starts_at).toLocaleString("en-US", {
				timeZone: TZ,
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			}),
			e.title.slice(0, 48),
		);
	}
	if (events.length > 6) console.log(`  … +${events.length - 6} more`);
	return rows.length;
}

// ───────── Guero's Taco Bar (TEC) ─────────
async function parseGueros() {
	const origin = "https://www.guerostacobar.com";
	const start = new Date().toISOString().slice(0, 10);
	const end = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
	const events = [];
	let page = 1;
	while (page <= 20) {
		const url = `${origin}/wp-json/tribe/events/v1/events?per_page=50&page=${page}&start_date=${start}&end_date=${end}&status=publish`;
		const text = await get(url);
		const j = JSON.parse(text);
		const batch = j.events || [];
		console.log(`  gueros page ${page}/${j.total_pages ?? "?"}: ${batch.length}`);
		for (const row of batch) {
			const title = stripHtml(row.title);
			if (!title) continue;
			const tz = row.timezone || TZ;
			// TEC start_date is local wall time
			const starts_at = localToUtc(row.start_date.replace(" ", "T").includes("T") ? row.start_date : row.start_date);
			// row.start_date is "2026-07-11 14:30:00"
			const starts = localToUtc(row.start_date);
			const ends = row.end_date ? localToUtc(row.end_date) : null;
			if (+new Date(starts) < Date.now() - 864e5) continue;
			const cost = stripHtml(row.cost || "");
			events.push({
				title,
				band: title.split(/[:–|]/)[0].trim(),
				starts_at: starts,
				ends_at: ends,
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
				confidence: 0.94,
			});
		}
		if (page >= (j.total_pages || 1) || batch.length === 0) break;
		page++;
	}
	// dedupe by tribe id
	const seen = new Set();
	const uniq = [];
	for (const e of events) {
		if (seen.has(e.source_event_id)) continue;
		seen.add(e.source_event_id);
		uniq.push(e);
	}
	uniq.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return uniq;
}

// ───────── Donn's Depot re-scrape (schema) ─────────
async function parseDonns() {
	const html = await get("https://www.donnsdepot.com/");
	const pairs = [
		...html.matchAll(
			/"name"\s*:\s*"((?:[^"\\]|\\.){2,100})"[\s\S]{0,800}?"startDate"\s*:\s*"([^"]+)"/g,
		),
	];
	const events = [];
	const seen = new Set();
	for (const m of pairs) {
		const title = stripHtml(m[1]);
		if (!title || /donn.?s depot|^home$|^schedule$|^contact$|^menu$|^faq/i.test(title)) continue;
		const raw = m[2];
		const mm = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/);
		let starts_at;
		if (mm) {
			const date = `${mm[1]}-${String(+mm[2]).padStart(2, "0")}-${String(+mm[3]).padStart(2, "0")}`;
			const time = `${String(+mm[4]).padStart(2, "0")}:${mm[5]}`;
			starts_at = localToUtc(`${date} ${time}:00`);
		} else {
			starts_at = new Date(raw).toISOString();
		}
		if (+new Date(starts_at) < Date.now() - 864e5) continue;
		const key = `${title}|${starts_at.slice(0, 16)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		events.push({
			title,
			band: title,
			starts_at,
			image_url: null,
			source_url: "https://www.donnsdepot.com/",
			source_event_id: key,
			raw_date_text: raw,
			ticket_url: "https://www.donnsdepot.com/",
			description: null,
			confidence: 0.9,
		});
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

// ───────── Vulcan Gas Company re-scrape ─────────
async function parseVulcan() {
	// Prefer SeatEngine / site event listing if present
	const urls = ["https://vulcanatx.com/", "https://vulcanatx.com/events", "https://www.vulcanatx.com/"];
	const events = [];
	const seen = new Set();
	for (const url of urls) {
		let html;
		try {
			html = await get(url);
		} catch {
			continue;
		}
		// schema events
		const chunks = html.split(/"@type"\s*:\s*"Event"/i).slice(1);
		for (const chunk of chunks) {
			const name = stripHtml(chunk.match(/"name"\s*:\s*"((?:[^"\\]|\\.)+)"/)?.[1] || "");
			const startDate = chunk.match(/"startDate"\s*:\s*"([^"]+)"/)?.[1];
			const image = chunk.match(/"image"\s*:\s*"(https:[^"]+)"/)?.[1]?.replace(/\\u002F/g, "/");
			const eventUrl = chunk.match(/"url"\s*:\s*"(https:[^"]+)"/)?.[1]?.replace(/\\u002F/g, "/");
			if (!name || !startDate) continue;
			const mm = startDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/);
			let starts_at;
			if (mm) {
				const date = `${mm[1]}-${String(+mm[2]).padStart(2, "0")}-${String(+mm[3]).padStart(2, "0")}`;
				const time = `${String(+mm[4]).padStart(2, "0")}:${mm[5]}`;
				starts_at = localToUtc(`${date} ${time}:00`);
			} else starts_at = new Date(startDate).toISOString();
			if (+new Date(starts_at) < Date.now() - 864e5) continue;
			const key = `${name}|${starts_at.slice(0, 16)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			events.push({
				title: name,
				band: name,
				starts_at,
				image_url: image || null,
				source_url: eventUrl || url,
				source_event_id: key,
				raw_date_text: startDate,
				ticket_url: eventUrl || url,
				confidence: 0.9,
			});
		}
		// seatengine show links
		const se = [...html.matchAll(/seatengine\.com\/[^"'?\s]+/gi)].map((m) => m[0]);
		if (se.length) console.log("  vulcan seatengine links", se.length);
		if (events.length) break;
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

const results = [];
console.log("=== Pilot round 5 ===\n");

try {
	console.log("Guero's Taco Bar…");
	const gueros = await parseGueros();
	results.push([
		"gueros-taco-bar",
		await stage(
			"gueros-taco-bar",
			"tec",
			"https://www.guerostacobar.com/events/",
			"https://www.guerostacobar.com/",
			gueros,
			"Guero's Taco Bar",
			{
				address: "1412 S Congress Ave, Austin, TX 78704",
				description: "South Congress Tex-Mex institution with a backyard stage and free live music.",
			},
		),
	]);
} catch (e) {
	console.log("Guero's ERR", e.message);
}

try {
	console.log("\nDonn's Depot refresh…");
	const donns = await parseDonns();
	results.push([
		"donns-depot",
		await stage(
			"donns-depot",
			"schema_events",
			"https://www.donnsdepot.com/",
			"https://www.donnsdepot.com/",
			donns,
			"Donn's Depot",
			{
				address: "1600 W 5th St, Austin, TX 78703",
				description: "Historic Austin train-depot dancehall with live music every night.",
			},
		),
	]);
} catch (e) {
	console.log("Donn's ERR", e.message);
}

try {
	console.log("\nVulcan Gas Company refresh…");
	const vulcan = await parseVulcan();
	results.push([
		"vulcan-gas-company",
		await stage(
			"vulcan-gas-company",
			"webflow",
			"https://vulcanatx.com/",
			"https://vulcanatx.com/",
			vulcan,
			"Vulcan Gas Company",
			{ address: "418 E 6th St, Austin, TX 78701" },
		),
	]);
} catch (e) {
	console.log("Vulcan ERR", e.message);
}

console.log("\n──── Summary ────");
for (const [slug, n] of results) console.log(`  ${String(n).padStart(3)}  ${slug}`);
console.log("\nAdmin → https://events-platform-admin.ben-745.workers.dev/ingestion");
