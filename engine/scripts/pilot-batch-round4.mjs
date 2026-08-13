/**
 * Pilot round 4 — new venues:
 * - Long Center (thelongcenter.org/calendar)
 * - Donn's Depot (donnsdepot.com schema events) — create venue if missing
 * - Skipped if empty after parse
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
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
		.replace(/\\u0026/gi, "&")
		.replace(/\\'/g, "'")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
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
	return `${openers[i % openers.length]} Austin live music energy. Showtime around ${time}. Grab tickets and get there early.`;
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
/** Parse "2026-7-10T21:00-4:00" or ISO as America/Chicago wall time when offset is noisy */
function parseFlexibleStart(raw) {
	const m = String(raw).match(
		/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/,
	);
	if (m) {
		const y = m[1];
		const mo = String(+m[2]).padStart(2, "0");
		const d = String(+m[3]).padStart(2, "0");
		const hh = String(+m[4]).padStart(2, "0");
		const mm = m[5];
		const ss = m[6] || "00";
		return localToUtc(`${y}-${mo}-${d} ${hh}:${mm}:${ss}`);
	}
	const t = +new Date(raw);
	if (!Number.isNaN(t)) return new Date(t).toISOString();
	return null;
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
async function rehost(siteId, folder, alt, imageUrl) {
	if (!imageUrl) return null;
	if (/supabase\.co\/storage/i.test(imageUrl)) return imageUrl;
	try {
		let fetchUrl = imageUrl;
		if (/rackcdn\.com/i.test(fetchUrl)) fetchUrl = fetchUrl.replace(/^https:\/\//i, "http://");
		const r = await fetch(fetchUrl, {
			headers: { "User-Agent": UA, Accept: "image/*,*/*" },
			redirect: "follow",
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
		const {
			data: { publicUrl },
		} = sb.storage.from("event-media").getPublicUrl(path);
		return publicUrl;
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
				updated_at: new Date().toISOString(),
			})
			.eq("id", venue.id);
		return venue;
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
		const desc = e.description || hype(band, venueLabel, e.starts_at, i);
		const hosted = e.image_url
			? await rehost(site.id, slug.slice(0, 24), e.title, e.image_url)
			: null;
		rows.push({
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
				image_url: hosted,
				source_image_url: e.image_url || null,
				confidence: e.confidence ?? 0.9,
				import_method: "feed",
				platform,
			},
		});
	}

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
			e.title.slice(0, 48),
			e.image_url ? "🖼" : "·",
		);
	}
	return rows.length;
}

// ───────── Long Center ─────────
async function parseLongCenter() {
	const cal = "https://thelongcenter.org/calendar";
	const html = await get(cal);
	const paths = [
		...new Set(
			[...html.matchAll(/href="(https:\/\/thelongcenter\.org\/events\/[^"#?]+)"/gi)].map((m) =>
				m[1].replace(/\/$/, ""),
			),
		),
	].filter((p) => !/\/var\//i.test(p));

	const events = [];
	const seen = new Set();
	for (const url of paths) {
		try {
			const d = await get(url);
			const title = stripHtml(
				d.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
					d.match(/property=["']og:title["']\s+content=["']([^"']+)/i)?.[1] ||
					"",
			)
				.replace(/\s*[|–-]\s*Long Center.*$/i, "")
				.trim();
			const startRaw = d.match(/"startDate"\s*:\s*"([^"]+)"/)?.[1];
			if (!title || !startRaw) continue;
			const starts_at = parseFlexibleStart(startRaw);
			if (!starts_at || +new Date(starts_at) < Date.now() - 864e5) continue;
			const key = `${title}|${starts_at.slice(0, 16)}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const image_url =
				d.match(/property=["']og:image["']\s+content=["']([^"']+)/i)?.[1] ||
				d.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i)?.[1] ||
				null;
			const desc =
				stripHtml(d.match(/property=["']og:description["']\s+content=["']([^"']+)/i)?.[1] || "") ||
				null;
			const ticket =
				d.match(/href=["'](https?:\/\/[^"']*(?:ticket|purchase|buy)[^"']*)["']/i)?.[1] || url;

			// Prefer series date from path uniqueness - Drop-In has multiple dates via separate paths
			events.push({
				title,
				band: title.split(/[:–|,]/)[0].trim(),
				starts_at,
				image_url,
				source_url: url,
				source_event_id: url.replace("https://thelongcenter.org", ""),
				raw_date_text: startRaw,
				ticket_url: ticket,
				description: desc && desc.length > 30 ? desc.slice(0, 800) : null,
				confidence: 0.92,
			});
		} catch (e) {
			console.log("long center detail fail", url, e.message);
		}
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

// ───────── Donn's Depot ─────────
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
		const starts_at = parseFlexibleStart(m[2]);
		if (!starts_at || +new Date(starts_at) < Date.now() - 864e5) continue;
		const key = `${title}|${starts_at.slice(0, 16)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		events.push({
			title,
			band: title,
			starts_at,
			image_url: null, // no per-event art on site
			source_url: "https://www.donnsdepot.com/",
			source_event_id: key,
			raw_date_text: m[2],
			ticket_url: "https://www.donnsdepot.com/",
			description: null,
			confidence: 0.9,
		});
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

// ───────── ACL Live at 3TEN (filter page) ─────────
async function parse3ten() {
	// Reuse ACL Live month filter but only 3TEN venue cards
	const months = [
		["2026", "July"],
		["2026", "August"],
		["2026", "September"],
		["2026", "October"],
		["2026", "November"],
		["2026", "December"],
	];
	const events = [];
	const seen = new Set();
	for (const [year, month] of months) {
		let html;
		try {
			// venue-filtered list if available
			html = await get(`https://www.acllive.com/events/venue/acl-live-at-3ten`);
			// also try monthly on main with data-venue
			if (month !== "July") {
				// page may list all months; only fetch once if first succeeds with enough
			}
		} catch {
			continue;
		}
		// Prefer filtered URL content; break after first successful full parse
		const cards = [
			...html.matchAll(
				/<a href="https?:\/\/www\.acllive\.com(\/event\/[^"]+)"[^>]*title="More Info for ([^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi,
			),
		];
		// Also data-venue attribute cards for 3TEN
		const venueCards = [
			...html.matchAll(
				/data-venue="[^"]*3[^"]*"[\s\S]{0,1200}?href="https?:\/\/www\.acllive\.com(\/event\/[^"]+)"[^>]*title="More Info for ([^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi,
			),
		];
		const list = venueCards.length ? venueCards : cards;
		for (const m of list) {
			const path = m[1];
			if (seen.has(path)) continue;
			// Prefer paths that look like date-based
			const title = stripHtml(m[2]);
			if (/premium pass|pnc hall/i.test(title)) continue;
			const img = m[3];
			const iso = path.match(/\/event\/(\d{4})-(\d{2})-(\d{2})-(.+?)(?:-at-(\d{1,2})-(\d{2})-?(am|pm))?$/i);
			let date = null;
			let time = "20:00";
			if (iso) {
				date = `${iso[1]}-${iso[2]}-${iso[3]}`;
				if (iso[5] && iso[6]) {
					let h = +iso[5];
					const ap = (iso[7] || "pm").toLowerCase();
					if (ap === "pm" && h < 12) h += 12;
					if (ap === "am" && h === 12) h = 0;
					time = `${String(h).padStart(2, "0")}:${iso[6]}`;
				}
			}
			// filter: only if page is 3ten venue page OR path/title mentions 3TEN
			const is3tenPage = /acl-live-at-3ten/i.test(html.slice(0, 500)) || /3ten/i.test(path + title);
			// When using venue-filtered URL, accept all cards on page
			if (!date) continue;
			seen.add(path);
			const starts_at = localToUtc(`${date} ${time}:00`);
			if (+new Date(starts_at) < Date.now() - 864e5) continue;
			if (+new Date(starts_at) > Date.now() + 200 * 864e5) continue;
			events.push({
				title,
				band: title,
				starts_at,
				image_url: img,
				source_url: `https://www.acllive.com${path}`,
				source_event_id: path,
				raw_date_text: `${date} ${time}`,
				ticket_url: `https://www.acllive.com${path}`,
				confidence: 0.91,
			});
		}
		break; // venue page is not monthly
	}
	// If venue page didn't yield, try main calendar data-venue=3
	if (events.length < 3) {
		for (const [year, month] of months) {
			try {
				const html = await get(`https://www.acllive.com/events/filtered/${year}/${month}`);
				const cards = [
					...html.matchAll(
						/data-venue="3"[\s\S]{0,1500}?href="https?:\/\/www\.acllive\.com(\/event\/[^"]+)"[^>]*title="More Info for ([^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi,
					),
				];
				for (const m of cards) {
					const path = m[1];
					if (seen.has(path)) continue;
					seen.add(path);
					const title = stripHtml(m[2]);
					if (/premium pass/i.test(title)) continue;
					const img = m[3];
					const iso = path.match(/\/event\/(\d{4})-(\d{2})-(\d{2})-(.+?)(?:-at-(\d{1,2})-(\d{2})-?(am|pm))?$/i);
					if (!iso) continue;
					const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
					let time = "20:00";
					if (iso[5] && iso[6]) {
						let h = +iso[5];
						const ap = (iso[7] || "pm").toLowerCase();
						if (ap === "pm" && h < 12) h += 12;
						if (ap === "am" && h === 12) h = 0;
						time = `${String(h).padStart(2, "0")}:${iso[6]}`;
					}
					const starts_at = localToUtc(`${date} ${time}:00`);
					if (+new Date(starts_at) < Date.now() - 864e5) continue;
					events.push({
						title,
						band: title,
						starts_at,
						image_url: img,
						source_url: `https://www.acllive.com${path}`,
						source_event_id: path,
						raw_date_text: `${date} ${time}`,
						ticket_url: `https://www.acllive.com${path}`,
						confidence: 0.91,
					});
				}
			} catch {
				/* continue */
			}
		}
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

const results = [];

try {
	const long = await parseLongCenter();
	results.push([
		"long-center",
		await stage(
			"long-center",
			"longcenter",
			"https://thelongcenter.org/calendar",
			"https://thelongcenter.org/",
			long,
			"Long Center",
			{ address: "701 W Riverside Dr, Austin, TX 78704" },
		),
	]);
} catch (e) {
	console.log("Long Center ERR", e.message);
}

try {
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
	// 3TEN room events stage into the combined ACL Live / Moody Theater venue
	const t3 = await parse3ten();
	results.push([
		"acl-live",
		await stage(
			"acl-live",
			"axs",
			"https://www.acllive.com/events",
			"https://www.acllive.com/",
			t3,
			"ACL Live at the Moody Theater",
			{ address: "310 W Willie Nelson Blvd, Austin, TX 78701, USA" },
		),
	]);
} catch (e) {
	console.log("3TEN/ACL Live ERR", e.message);
}

console.log("\n──── Summary ────");
for (const [slug, n] of results) console.log(`  ${String(n).padStart(3)}  ${slug}`);
console.log("\nDone → https://events-platform-admin.ben-745.workers.dev/ingestion");
