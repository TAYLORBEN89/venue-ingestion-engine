/**
 * Round 2 pilots: enrich Germania images, fix Friends titles,
 * pilot White Horse (Wix), COTA if possible.
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
		.replace(/&#x27;/gi, "'")
		.replace(/&#39;/gi, "'")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&quot;/gi, '"')
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
function fp(title, starts, ticket) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${ticket ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}
async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" },
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

async function stage(slug, platform, calendarUrl, websiteUrl, events, venueLabel) {
	const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
	const { data: venue } = await sb
		.from("venues")
		.select("id, name")
		.eq("site_id", site.id)
		.eq("slug", slug)
		.maybeSingle();
	if (!venue) {
		console.log("missing", slug);
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
		const band = (e.title.split(/[:–-]/)[0] || e.title).trim();
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
				confidence: e.confidence ?? 0.9,
				import_method: "feed",
				platform,
			},
		};
	});
	for (let i = 0; i < rows.length; i += 40) {
		const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
		if (error) throw new Error(error.message);
	}
	console.log(
		`\n=== ${venue.name} === staged ${rows.length} images ${rows.filter((r) => r.raw_payload.image_url).length}`,
	);
	for (const e of events.slice(0, 4)) {
		console.log(
			" ",
			new Date(e.starts_at).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
			e.title.slice(0, 48),
			!!e.image_url,
		);
	}
	return rows.length;
}

// ---- Germania: parse MusicEvent JSON embedded without script tags type ----
{
	const url = "https://www.ticketmaster.com/germania-insurance-amphitheater-tickets-austin/venue/476047";
	const html = await get(url);
	const events = [];
	// Find @type MusicEvent objects in page
	const re = /\{"@context":"https:\/\/schema\.org","@type":"MusicEvent"[\s\S]*?\}\s*(?=,\{"@context"|<\/script>|$)/g;
	// simpler: match name + startDate + image near each other in HTML
	const chunks = html.split('"@type":"MusicEvent"').slice(1);
	for (const chunk of chunks) {
		const name = chunk.match(/"name":"([^"\\]+)"/)?.[1];
		const startDate = chunk.match(/"startDate":"([^"]+)"/)?.[1];
		const endDate = chunk.match(/"endDate":"([^"]+)"/)?.[1];
		const image = chunk.match(/"image":"(https:[^"]+)"/)?.[1];
		const eventUrl = chunk.match(/"url":"(https:[^"]+ticketmaster[^"]+)"/)?.[1];
		if (!name || !startDate) continue;
		if (/parking|not a concert|vip package/i.test(name)) continue;
		const m = startDate.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
		const starts_at = m
			? localToUtc(`${m[1]} ${m[2]}:${m[3] || "00"}`)
			: new Date(startDate).toISOString();
		if (+new Date(starts_at) < Date.now() - 864e5) continue;
		events.push({
			title: name.replace(/\\u0026/g, "&").replace(/\\"/g, '"'),
			starts_at,
			image_url: image?.replace(/\\u002F/g, "/"),
			source_url: (eventUrl || url).replace(/\\u002F/g, "/"),
			source_event_id: (eventUrl || "").match(/event\/([A-Za-z0-9]+)/)?.[1] || `${name}|${starts_at}`,
			raw_date_text: startDate,
			ticket_url: (eventUrl || url).replace(/\\u002F/g, "/"),
			confidence: 0.93,
		});
	}
	// dedupe
	const seen = new Set();
	const uniq = [];
	for (const e of events) {
		if (seen.has(e.source_event_id)) continue;
		seen.add(e.source_event_id);
		uniq.push(e);
	}
	uniq.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	await stage(
		"germania-insurance-amphitheater",
		"livenation",
		"https://www.germaniaamp.com/events",
		"https://www.germaniaamp.com/",
		uniq,
		"Germania Insurance Amphitheater",
	);
}

// ---- White Horse: try Wix events API / calendar page ----
{
	const urls = [
		"https://thewhitehorseaustin.com/events",
		"https://www.thewhitehorseaustin.com/events",
	];
	const events = [];
	for (const url of urls) {
		try {
			const html = await get(url);
			// Wix events pattern
			const links = [
				...html.matchAll(
					/event-details\/([a-z0-9%-]+)-(\d{4}-\d{2}-\d{2})[^"]*"[^>]*>([^<]{2,100})</gi,
				),
			];
			const seen = new Set();
			for (const m of links) {
				const title = stripHtml(m[3]);
				const date = m[2];
				const key = `${title}|${date}`;
				if (seen.has(key) || !title) continue;
				seen.add(key);
				const starts_at = localToUtc(`${date} 20:00:00`);
				if (+new Date(starts_at) < Date.now() - 864e5) continue;
				const href = `https://thewhitehorseaustin.com/event-details/${m[1]}-${date}`;
				events.push({
					title,
					starts_at,
					source_url: href,
					source_event_id: key,
					raw_date_text: date,
					ticket_url: href,
					confidence: 0.82,
				});
			}
			// eventbrite embeds
			const eb = [...html.matchAll(/eventbrite\.com\/e\/([^"'?\s]+)/gi)].map((m) => m[0]);
			console.log("white horse wix events", events.length, "eb", new Set(eb).size);
			if (events.length) break;
		} catch (e) {
			console.log("wh", e.message);
		}
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	if (events.length) {
		await stage(
			"the-white-horse",
			"wix_events",
			"https://thewhitehorseaustin.com/events",
			"https://thewhitehorseaustin.com/",
			events,
			"The White Horse",
		);
	} else console.log("\n=== White Horse === no events parsed");
}

// ---- Friends Bar refresh with decoded titles ----
{
	const html = await get("https://www.friendsbar.com/calendar");
	const events = [];
	const seen = new Set();
	const links = [
		...html.matchAll(
			/event-details\/([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})[^"]*"[^>]*>([^<]{2,100})</gi,
		),
	];
	for (const m of links) {
		const title = stripHtml(m[3]);
		const date = m[2];
		const slug = m[1];
		const key = `${slug}|${date}`;
		if (seen.has(key) || !title) continue;
		seen.add(key);
		// Try to find image before this match
		const start = Math.max(0, m.index - 1500);
		const window = html.slice(start, m.index + 200);
		const img =
			window.match(/src="(https:\/\/static\.wixstatic\.com\/media\/[^"]+)"/i)?.[1] ||
			window.match(/srcSet="(https:\/\/static\.wixstatic\.com\/media\/[^"\s]+)/i)?.[1] ||
			null;
		const starts_at = localToUtc(`${date} 21:00:00`); // Friends often late
		if (+new Date(starts_at) < Date.now() - 864e5) continue;
		const eventUrl = `https://www.friendsbar.com/event-details/${slug}-${date}-12-00`;
		events.push({
			title,
			starts_at,
			image_url: img,
			source_url: eventUrl,
			source_event_id: key,
			raw_date_text: date,
			ticket_url: eventUrl,
			confidence: 0.85,
		});
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	await stage("friends-bar", "wix_events", "https://www.friendsbar.com/calendar", "https://www.friendsbar.com/", events, "Friends Bar");
}

// ---- Hole in the Wall homepage scrape for listed shows ----
{
	try {
		const html = await get("https://www.holeinthewallaustin.com/");
		const events = [];
		// common patterns: dates + band names
		// try seetickets / dice / prekindle links
		const showLinks = [
			...html.matchAll(/href="(https?:\/\/[^"]+)"[^>]*>([^<]{3,80})</gi),
		].filter((m) => /event|show|ticket|dice|prekindle|seetickets/i.test(m[1] + m[2]));
		console.log("hole links interesting", showLinks.length);
		// MusicEvent
		for (const b of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
			try {
				const raw = JSON.parse(b[1]);
				const items = Array.isArray(raw) ? raw : [raw];
				for (const item of items) {
					if (item["@type"] !== "MusicEvent" && item["@type"] !== "Event") continue;
					if (!item.name || !item.startDate) continue;
					const m = String(item.startDate).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
					const starts_at = m ? localToUtc(`${m[1]} ${m[2]}:00`) : new Date(item.startDate).toISOString();
					if (+new Date(starts_at) < Date.now() - 864e5) continue;
					events.push({
						title: item.name,
						starts_at,
						image_url: typeof item.image === "string" ? item.image : null,
						source_url: item.url || "https://www.holeinthewallaustin.com/",
						source_event_id: item.url || `${item.name}|${starts_at}`,
						raw_date_text: item.startDate,
						ticket_url: item.url || "https://www.holeinthewallaustin.com/",
						confidence: 0.88,
					});
				}
			} catch {}
		}
		if (events.length) {
			await stage(
				"hole-in-the-wall",
				"jsonld",
				"https://www.holeinthewallaustin.com/",
				"https://www.holeinthewallaustin.com/",
				events,
				"Hole in the Wall",
			);
		} else console.log("\n=== Hole in the Wall === no events");
	} catch (e) {
		console.log("hole", e.message);
	}
}

console.log("\nDone → https://events-platform-admin.ben-745.workers.dev/ingestion");
