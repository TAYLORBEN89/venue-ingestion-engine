/**
 * Re-pilot Saxon (date fix), Elephant, Scoot, Esther — pure JS, stages pending.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devVars = readFileSync(resolve(__dirname, "../.dev.vars"), "utf8");
const env = Object.fromEntries(
	devVars
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
	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		hour,
		Number(parts.minute),
		Number(parts.second),
	);
	return (asUtc - at.getTime()) / 60_000;
}
function localToUtc(local, timeZone = TZ) {
	const [datePart, timePart] = local.replace("T", " ").split(" ");
	const [y, m, d] = datePart.split("-").map(Number);
	const [hh, mm, ss = 0] = timePart.split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, Number(ss)));
	return new Date(guess.getTime() - getOffsetMin(timeZone, guess) * 60_000).toISOString();
}
function stripHtml(v) {
	return String(v || "")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ")
		.replace(/&#036;/g, "$")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
function absHttps(href) {
	if (!href) return null;
	if (href.startsWith("//")) return `https:${href}`;
	return href;
}
function fp(title, starts, ticket) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${ticket ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}
async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 events-platform-repilot", Accept: "*/*" },
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

async function stage(slug, platform, calendarUrl, websiteUrl, events) {
	const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
	const updates = { calendar_url: calendarUrl };
	if (websiteUrl) updates.website_url = websiteUrl;
	const { data: venue } = await sb
		.from("venues")
		.update(updates)
		.eq("site_id", site.id)
		.eq("slug", slug)
		.select("id, name")
		.single();

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

	const rows = events.map((e) => ({
		ingestion_run_id: run.id,
		venue_id: venue.id,
		raw_title: e.title,
		raw_date_text: e.raw_date_text ?? null,
		parsed_starts_at: e.starts_at,
		parsed_ends_at: e.ends_at ?? null,
		source_url: e.source_url,
		source_event_id: e.source_event_id ?? null,
		fingerprint: fp(e.title, e.starts_at, e.ticket_url),
		source_partner: platform,
		extracted_band_name: e.title,
		matched_artist_id: null,
		artist_match_status: "unmatched",
		match_status: "new",
		matched_event_id: null,
		review_status: "pending",
		raw_payload: {
			description: e.description ?? null,
			price_text: e.price_text ?? null,
			ticket_url: e.ticket_url ?? e.source_url,
			image_url: e.image_url ?? null,
			confidence: e.confidence ?? 0.9,
			import_method: "feed",
			platform,
		},
	}));

	for (let i = 0; i < rows.length; i += 40) {
		const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
		if (error) throw new Error(`${slug}: ${error.message}`);
	}

	const withImg = rows.filter((r) => r.raw_payload.image_url).length;
	const withDesc = rows.filter((r) => r.raw_payload.description).length;
	console.log(`\n=== ${venue.name} ===`);
	console.log(`staged ${rows.length} | images ${withImg} | desc ${withDesc}`);
	for (const e of events.slice(0, 5)) {
		const local = new Date(e.starts_at).toLocaleString("en-US", {
			timeZone: TZ,
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
		console.log(`  ${local} | ${e.title.slice(0, 48)} | img=${!!e.image_url}`);
	}
}

// ---- SAXON (TEC REST, local wall time) ----
{
	const events = [];
	const startDate = new Date().toISOString().slice(0, 10);
	const endDate = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
	for (let page = 1; page <= 4 && events.length < 80; page++) {
		const url = `https://thesaxonpub.com/wp-json/tribe/events/v1/events?per_page=50&page=${page}&start_date=${startDate}&end_date=${endDate}&status=publish`;
		const j = JSON.parse(await get(url));
		for (const row of j.events ?? []) {
			const tz = row.timezone || TZ;
			const starts_at = localToUtc(row.start_date, tz);
			const ends_at = row.end_date ? localToUtc(row.end_date, tz) : null;
			const cost = stripHtml(row.cost || "");
			events.push({
				title: stripHtml(row.title),
				starts_at,
				ends_at,
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
				confidence: 0.95,
			});
		}
		if (page >= (j.total_pages || 1)) break;
	}
	await stage("the-saxon-pub", "tec", "https://thesaxonpub.com/events/", null, events);
}

// ---- ELEPHANT (Zoogle pages 1-7) ----
{
	const MONTHS = {
		january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
		july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
		jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
	};
	function parseWhen(text) {
		const m = text.match(
			/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}).*?@\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i,
		);
		if (!m) return null;
		const mon = MONTHS[m[1].toLowerCase()];
		const day = +m[2];
		let year = new Date().getFullYear();
		let hour = +m[3];
		const minute = m[4];
		const ap = m[5].toUpperCase();
		if (ap === "PM" && hour < 12) hour += 12;
		if (ap === "AM" && hour === 12) hour = 0;
		const cand = new Date(year, mon - 1, day);
		if (cand.getTime() < Date.now() - 45 * 864e5) year++;
		const wall = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${minute}:00`;
		return localToUtc(wall, TZ);
	}

	const seen = new Set();
	const events = [];
	const featureId = "1147558";
	for (let page = 1; page <= 7; page++) {
		const html = await get(
			`https://elephantroom.com/calendar/features/load/calendar_feature_${featureId}.turbo_stream?calendar_page=${page}`,
		);
		const parts = html.split(/class="event-detail"/i).slice(1);
		for (const part of parts) {
			const eventId = part.match(/data-event-id="(\d+)"/i)?.[1];
			const occId = part.match(/data-occurrence-id="(\d+)"/i)?.[1];
			if (!eventId) continue;
			const key = `${eventId}:${occId || ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const title =
				stripHtml(part.match(/class="[^"]*event-title[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "") ||
				stripHtml(part.match(/title="([^"]+)"/i)?.[1] || "");
			if (!title) continue;
			// Full datetime lives under .event-datetime (date + time spans nested)
			const when =
				stripHtml(part.match(/class="[^"]*event-datetime[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "") ||
				stripHtml(part.match(/class="[^"]*event-when[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/i)?.[1] || "");
			const starts_at = parseWhen(when);
			if (!starts_at) continue;
			if (new Date(starts_at).getTime() < Date.now() - 864e5) continue;
			const large =
				part.match(/data-featherlight="([^"]+)"/i)?.[1] ||
				part.match(/class="thumbnail-popup"[^>]*href="([^"]+)"/i)?.[1] ||
				part.match(/<img[^>]+src="([^"]+)"/i)?.[1];
			const after =
				part.split(/event-info-wrapper[\s\S]*?<\/div>\s*<\/div>/i)[1] ||
				part.split(/event-location[\s\S]*?<\/p>/i)[1] ||
				"";
			const desc = stripHtml(
				after
					.replace(/class="event-info buying[\s\S]*/i, "")
					.replace(/class="event-info map-link[\s\S]*/i, "")
					.replace(/class="event-clear"[\s\S]*/i, "")
					.slice(0, 1200),
			);
			const eventUrl =
				part.match(/href="(https?:\/\/[^"]*\/event\/[^"]+)"/i)?.[1] ||
				`https://elephantroom.com/event/${eventId}/${occId || ""}`;
			events.push({
				title,
				starts_at,
				description: desc.length > 40 ? desc : null,
				image_url: absHttps(large),
				source_url: eventUrl,
				source_event_id: key,
				raw_date_text: when,
				ticket_url: eventUrl,
				confidence: 0.92,
			});
		}
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	await stage("elephant-room", "zoogle", "https://elephantroom.com/calendar", null, events);
}

// ---- SCOOT (JSON-LD MusicEvent on homepage) ----
{
	const html = await get("https://scootinnaustin.com/");
	const events = [];
	const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
	for (const b of blocks) {
		try {
			const raw = JSON.parse(b[1]);
			const items = Array.isArray(raw) ? raw : raw["@graph"] ? raw["@graph"] : [raw];
			for (const item of items) {
				if (item["@type"] !== "MusicEvent" && item["@type"] !== "Event") continue;
				const name = (item.name || "").trim();
				if (!name || /parking|not a concert|vip package|longhorn lounge/i.test(name)) continue;
				if (!item.startDate) continue;
				const m = item.startDate.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
				const starts_at = m
					? localToUtc(`${m[1]} ${m[2]}:${m[3] || "00"}`, TZ)
					: new Date(item.startDate).toISOString();
				const img = typeof item.image === "string" ? item.image : Array.isArray(item.image) ? item.image[0] : null;
				const offers = item.offers;
				const ticket = (Array.isArray(offers) ? offers[0]?.url : offers?.url) || item.url;
				const price = !Array.isArray(offers) && offers?.price != null ? `$${offers.price}` : null;
				events.push({
					title: name,
					starts_at,
					description: item.description ? stripHtml(item.description) : null,
					image_url: img,
					source_url: ticket || item.url,
					source_event_id: ticket?.match(/event\/([A-Za-z0-9]+)/i)?.[1] || `${name}|${starts_at}`,
					raw_date_text: item.startDate,
					price_text: price,
					ticket_url: ticket,
					confidence: 0.93,
				});
			}
		} catch {}
	}
	const seen = new Set();
	const uniq = [];
	for (const e of events) {
		const k = e.source_event_id;
		if (seen.has(k)) continue;
		seen.add(k);
		uniq.push(e);
	}
	uniq.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	await stage("the-historic-scoot-inn", "livenation", "https://scootinnaustin.com/events", "https://scootinnaustin.com/", uniq);
}

// ---- ESTHER'S recurring ----
{
	const slots = [
		{ weekday: 4, hour: 20, minute: 0, title: "Esther's Follies — Thursday Night Show" },
		{ weekday: 5, hour: 19, minute: 0, title: "Esther's Follies — Friday Early Show" },
		{ weekday: 5, hour: 21, minute: 0, title: "Esther's Follies — Friday Late Show" },
		{ weekday: 6, hour: 19, minute: 0, title: "Esther's Follies — Saturday Early Show" },
		{ weekday: 6, hour: 21, minute: 0, title: "Esther's Follies — Saturday Late Show" },
	];
	const events = [];
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	for (let d = 0; d < 45; d++) {
		const day = new Date(start.getTime() + d * 864e5);
		const wd = day.getDay();
		const y = day.getFullYear();
		const mo = day.getMonth() + 1;
		const da = day.getDate();
		for (const slot of slots) {
			if (slot.weekday !== wd) continue;
			const wall = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")} ${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}:00`;
			const starts_at = localToUtc(wall, TZ);
			if (new Date(starts_at) < Date.now() - 3600e3) continue;
			events.push({
				title: slot.title,
				starts_at,
				description:
					"Esther's Follies presents Austin's legendary musical comedy revue — sketch comedy, song, and magic on Dirty Sixth. Tickets at esthersfollies.com/tickets.",
				image_url: null,
				source_url: "https://esthersfollies.com/tickets",
				source_event_id: `esthers-${y}${String(mo).padStart(2, "0")}${String(da).padStart(2, "0")}-${slot.hour}${String(slot.minute).padStart(2, "0")}`,
				raw_date_text: wall,
				ticket_url: "https://esthersfollies.com/tickets",
				confidence: 0.85,
			});
		}
	}
	await stage("esther-s-follies", "esthers_follies", "https://esthersfollies.com/tickets", null, events);
}

console.log("\nAll done → https://events-platform-admin.ben-745.workers.dev/ingestion");
