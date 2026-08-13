/**
 * Moontower Saloon — restage with Spotapps event photos.
 * Source: https://moontowersaloon.com/austin-menchaca-moontower-saloon-events
 * Images: <img class="event-image" src="//static.spotapps.co/spots/.../w926">
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
const CAL = "https://moontowersaloon.com/austin-menchaca-moontower-saloon-events";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

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
	return `${openers[i % openers.length]} South Austin patio energy under the moon. Showtime around ${time}. Come early.`;
}
function absImg(src) {
	if (!src) return null;
	if (src.startsWith("//")) return `https:${src}`;
	if (src.startsWith("/")) return `https://moontowersaloon.com${src}`;
	return src;
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
	// "2026-07-10 20:00:00" America/Chicago
	const [datePart, timePart] = local.replace("T", " ").split(" ");
	const [y, m, d] = datePart.split("-").map(Number);
	const [hh, mm, ss = 0] = timePart.split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, +ss));
	return new Date(guess.getTime() - getOffsetMin(TZ, guess) * 60000).toISOString();
}

async function rehost(siteId, alt, imageUrl) {
	if (!imageUrl) return null;
	if (/supabase\.co\/storage/i.test(imageUrl)) return imageUrl;
	try {
		const r = await fetch(imageUrl, {
			headers: { "User-Agent": UA, Accept: "image/*,*/*", Referer: CAL },
			redirect: "follow",
		});
		if (!r.ok) {
			console.log("  fetch img fail", r.status, imageUrl.slice(0, 60));
			return imageUrl; // keep source https spotapps — usually works
		}
		const contentType = r.headers.get("content-type") ?? "image/jpeg";
		if (!contentType.startsWith("image/")) return imageUrl;
		const ext = contentType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ?? "jpg";
		const bytes = await r.arrayBuffer();
		const path = `${siteId}/moontower/${randomUUID()}.${ext}`;
		const { error } = await sb.storage
			.from("event-media")
			.upload(path, bytes, { contentType, upsert: false });
		if (error) {
			console.log("  upload fail", error.message);
			return imageUrl;
		}
		const {
			data: { publicUrl },
		} = sb.storage.from("event-media").getPublicUrl(path);
		return publicUrl;
	} catch (e) {
		console.log("  rehost err", e.message);
		return imageUrl;
	}
}

console.log("Fetching Moontower events…");
const html = await (
	await fetch(CAL, {
		headers: { "User-Agent": UA, Accept: "text/html" },
	})
).text();

// Sections: <section id="EVENTID"> ... event-image ... h2 title ... atc fields
const sectionRe =
	/<section[^>]*\bid=["'](\d+)["'][^>]*>([\s\S]*?)<\/section>/gi;
const events = [];
const seen = new Set();

for (const m of html.matchAll(sectionRe)) {
	const id = m[1];
	const body = m[2];
	const imgSrc =
		body.match(/<img[^>]*class=["'][^"']*event-image[^"']*["'][^>]*src=["']([^"']+)/i)?.[1] ||
		body.match(/src=["']([^"']*static\.spotapps\.co\/spots\/[^"']+)/i)?.[1] ||
		null;
	const imgAlt = body.match(/class=["'][^"']*event-image[^"']*["'][^>]*alt=["']([^"']*)/i)?.[1] || "";

	const title =
		stripHtml(body.match(/atc_title">([^<]+)/i)?.[1] || "") ||
		stripHtml(body.match(/<h2[^>]*>([^<]+)/i)?.[1] || "") ||
		stripHtml(imgAlt.replace(/\s*event photo\s*$/i, ""));

	const startLocal =
		body.match(/atc_date_start">(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i)?.[1] ||
		null;

	if (!title || !startLocal) continue;
	if (seen.has(id)) continue;
	seen.add(id);

	const liveMusic = /LIVE MUSIC/i.test(body);
	const isNationalOnly = /^National\s+.+\s+Day$/i.test(title) || /^(Labor Day|Memorial Day)$/i.test(title);
	// Keep live music + karaoke; drop pure holiday promos without music
	if (isNationalOnly && !liveMusic) continue;

	const starts_at = localToUtc(startLocal);
	if (+new Date(starts_at) < Date.now() - 864e5) continue;

	const description =
		stripHtml(body.match(/atc_description">([^<]+)/i)?.[1] || "") ||
		stripHtml(body.match(/event-info-text[\s\S]{0,400}?<p[^>]*>([^<]{20,400})/i)?.[1] || "") ||
		null;

	const image_url = absImg(imgSrc);

	events.push({
		title,
		band: title,
		starts_at,
		image_url,
		source_url: CAL,
		source_event_id: `moontower-${id}`,
		raw_date_text: startLocal,
		ticket_url: CAL,
		description: description && description.length > 15 ? description : null,
		confidence: 0.9,
		liveMusic,
	});
}

// Fallback if section parse fails: event-image alts + nearby atc
if (events.length < 3) {
	console.log("section parse thin — fallback…");
	const re =
		/<img[^>]*class=["'][^"']*event-image[^"']*["'][^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][\s\S]{0,3000}?atc_date_start">(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})[\s\S]{0,500}?atc_title">([^<]+)/gi;
	for (const m of html.matchAll(re)) {
		const title = stripHtml(m[4]);
		const starts_at = localToUtc(m[3]);
		if (+new Date(starts_at) < Date.now() - 864e5) continue;
		const key = `${title}|${m[3]}`;
		if (seen.has(key)) continue;
		seen.add(key);
		events.push({
			title,
			band: title,
			starts_at,
			image_url: absImg(m[1]),
			source_url: CAL,
			source_event_id: key,
			raw_date_text: m[3],
			ticket_url: CAL,
			description: null,
			confidence: 0.88,
		});
	}
}

events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(`Parsed ${events.length} events, images ${events.filter((e) => e.image_url).length}`);
for (const e of events) {
	console.log(
		" ",
		new Date(e.starts_at).toLocaleString("en-US", {
			timeZone: TZ,
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}),
		e.title.slice(0, 35),
		e.image_url ? "🖼" : "·",
		e.image_url?.replace("https://static.spotapps.co", "…").slice(0, 40),
	);
}

if (!events.length) {
	console.error("No events");
	process.exit(1);
}

// Stage
const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id, name")
	.eq("site_id", site.id)
	.eq("slug", "moontower-saloon")
	.single();

await sb
	.from("venues")
	.update({ calendar_url: CAL, website_url: "https://moontowersaloon.com/" })
	.eq("id", venue.id);

const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({
			platform_type: "spotapps",
			feed_url: CAL,
			calendar_url: CAL,
			updated_at: new Date().toISOString(),
		})
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "spotapps",
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

console.log("\nRe-hosting images…");
const venueName = "Moontower Saloon";
const rows = [];
for (let i = 0; i < events.length; i++) {
	const e = events[i];
	const hosted = await rehost(site.id, e.title, e.image_url);
	const desc = e.description || hype(e.band, venueName, e.starts_at, i);
	rows.push({
		ingestion_run_id: run.id,
		venue_id: venue.id,
		raw_title: e.title,
		raw_date_text: e.raw_date_text,
		parsed_starts_at: e.starts_at,
		parsed_ends_at: null,
		source_url: e.source_url,
		source_event_id: e.source_event_id,
		fingerprint: fp(e.title, e.starts_at, e.ticket_url),
		source_partner: "spotapps",
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
			image_url: hosted,
			source_image_url: e.image_url,
			confidence: e.confidence,
			import_method: "feed",
			platform: "spotapps",
		},
	});
	console.log(" ", e.title.slice(0, 30), /supabase/i.test(hosted || "") ? "✓ hosted" : hosted ? "source" : "no img");
}

const { error } = await sb.from("ingested_events").insert(rows);
if (error) throw new Error(error.message);

console.log(
	`\n=== Moontower Saloon === staged ${rows.length} images ${rows.filter((r) => r.raw_payload.image_url).length}`,
);
console.log("Done → https://events-platform-admin.ben-745.workers.dev/ingestion");
