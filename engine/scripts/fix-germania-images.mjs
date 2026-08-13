/**
 * Germania Insurance Amphitheater — event posters from germaniaamp.com
 *
 * Walk: /events → /events/{slug} → img in backgrounds/ or main-image/
 * Fallback: artist-images/ profile photos on the event page
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
const ORIGIN = "https://www.germaniaamp.com";
const CAL = `${ORIGIN}/events`;
const RACK = "http://afb145c802b6982cf224-2f69d2032bf508930eb1dd2863d96e5d.r69.cf1.rackcdn.com";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MONTHS = {
	january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
	july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
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
		.replace(/&#039;|&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
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
	return `${openers[i % openers.length]} Open-air amphitheater energy at Circuit of The Americas. Showtime around ${time}. Grab tickets and get there early.`;
}
function parseTime12(t, fallback = "19:00") {
	const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
	if (!m) return fallback;
	let h = +m[1];
	const min = m[2];
	const ap = m[3].toLowerCase();
	if (ap === "p" && h < 12) h += 12;
	if (ap === "a" && h === 12) h = 0;
	return `${String(h).padStart(2, "0")}:${min}`;
}
function absUrl(u) {
	if (!u) return null;
	if (u.startsWith("//")) return `https:${u}`;
	if (u.startsWith("/")) return `${ORIGIN}${u}`;
	return u.replace(/^http:\/\//, "https://");
}
function httpsPrefer(u) {
	return (u || "").replace(/^http:\/\//i, "https://");
}

/** Normalize artist tokens from slug for matching image filenames. */
function slugTokens(slug) {
	return slug
		.toLowerCase()
		.replace(/-\d+$/, "") // trailing -1
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 2 && !/^(and|the|with)$/.test(t));
}
function imageMatchesSlug(url, slug) {
	const file = decodeURIComponent(url.split("/").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
	const tokens = slugTokens(slug);
	if (!tokens.length) return false;
	// require most tokens present (handles dirty-heads-and-311)
	const hits = tokens.filter((t) => file.includes(t));
	return hits.length >= Math.min(2, tokens.length) || hits.length >= Math.ceil(tokens.length * 0.6);
}

async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

function pickEventImage(html, slug) {
	const all = [
		...new Set(
			[...html.matchAll(/https?:\/\/[^"'\s<>]*rackcdn\.com\/[^"'\s<>]+/gi)].map((m) => m[0]),
		),
	].filter((u) => !/OpenGraph|logo|Ticketmaster|sponsor|waterloo|holmatro|Amex|Coke|Karbach|Estrella|Titos|Shift4|F1-Sponsor|Untitled|TXDRA|MUL_Germania|DHL_Web|Patron|ticket-location/i.test(u));

	const backgrounds = all.filter((u) => /\/backgrounds\//i.test(u));
	const mains = all.filter((u) => /\/main-image\//i.test(u));
	const artists = all.filter((u) => /\/artist-images\//i.test(u));

	// 1) event poster matching this show (backgrounds preferred — venue website assets)
	for (const pool of [backgrounds, mains]) {
		const match = pool.find((u) => imageMatchesSlug(u, slug));
		if (match) return { url: httpsPrefer(match), kind: "event" };
	}
	// 2) any backgrounds image that's not generic
	if (backgrounds[0]) return { url: httpsPrefer(backgrounds[0]), kind: "event" };
	// 3) main-image matching slug already tried; first main-image that matches ANY artist-ish name in slug
	if (mains[0] && imageMatchesSlug(mains[0], slug)) return { url: httpsPrefer(mains[0]), kind: "event" };
	// Prefer main-image that appears first AFTER we've filtered - but detail pages include ALL shows' main-images in sidebar
	// So only use main if it matches slug
	// 4) artist profile photo
	if (artists[0]) return { url: httpsPrefer(artists[0]), kind: "artist" };
	// 5) last resort: main-image match loose
	const loose = mains.find((u) => {
		const file = u.toLowerCase();
		return slugTokens(slug).some((t) => t.length > 4 && file.includes(t));
	});
	if (loose) return { url: httpsPrefer(loose), kind: "event" };
	return { url: null, kind: null };
}

function pickArtistPhoto(html, slug) {
	const artists = [
		...new Set(
			[...html.matchAll(/https?:\/\/[^"'\s<>]*rackcdn\.com\/artist-images\/[^"'\s<>]+/gi)].map((m) => m[0]),
		),
	];
	if (!artists.length) return null;
	const match = artists.find((u) => imageMatchesSlug(u, slug));
	return httpsPrefer(match || artists[0]);
}

// ── Listing ──
console.log("Loading events listing…");
const listing = await get(CAL);
const slugs = [
	...new Set(
		[...listing.matchAll(/href=["'](?:https?:\/\/[^"']*)?\/events\/([a-z0-9-]+)["']/gi)].map((m) =>
			m[1].toLowerCase(),
		),
	),
].filter((s) => s && s !== "events");
console.log("slugs", slugs.length, slugs);

const events = [];
for (const slug of slugs) {
	const url = `${ORIGIN}/events/${slug}`;
	try {
		const html = await get(url);
		const title = stripHtml(
			html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
				html.match(/property=["']og:title["']\s+content=["']([^"']+)/i)?.[1] ||
				slug.replace(/-/g, " "),
		)
			.replace(/\s*\|\s*Germania.*$/i, "")
			.trim();

		// Date: "July 26, 2026" + time "06:00 pm"
		const dateM = html.match(
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
		);
		if (!dateM) {
			console.log("skip no date", slug);
			continue;
		}
		const mo = MONTHS[dateM[1].toLowerCase()];
		const date = `${dateM[3]}-${String(mo).padStart(2, "0")}-${String(+dateM[2]).padStart(2, "0")}`;

		// Prefer doors/show time near event; first time on page often is show
		const times = [...html.matchAll(/(\d{1,2}:\d{2}\s*[ap]\.?m\.?)/gi)].map((m) => m[1]);
		// Germania often lists 6:00 pm style early — use first reasonable evening time or first time
		let time = "19:00";
		if (times[0]) time = parseTime12(times[0], "19:00");
		// If there's a later "show" marker
		const showAt = html.match(/show\s*(?:time)?[:\s]+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)/i)?.[1];
		if (showAt) time = parseTime12(showAt, time);

		const starts_at = localToUtc(`${date} ${time}:00`);
		if (+new Date(starts_at) < Date.now() - 864e5) {
			console.log("skip past", date, title);
			continue;
		}

		const picked = pickEventImage(html, slug);
		const artistPhoto = pickArtistPhoto(html, slug);
		const image_url = picked.url || artistPhoto;

		// Ticketmaster event link if present
		const ticket =
			html.match(/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/event\/[^"']+)/i)?.[1] ||
			html.match(/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/[^"']*ticket[^"']+)/i)?.[1] ||
			url;

		// Description: try event body, not venue generic
		let description = null;
		const ogDesc = html.match(/property=["']og:description["']\s+content=["']([^"']+)/i)?.[1];
		if (ogDesc && !/stars on the stage and above it/i.test(ogDesc) && ogDesc.length > 40) {
			description = stripHtml(ogDesc);
		}
		const body = html.match(
			/<div[^>]*class="[^"]*(?:event-description|event__description|description)[^"]*"[^>]*>([\s\S]{40,1200}?)<\/div>/i,
		);
		if (body) {
			const d = stripHtml(body[1]);
			if (d.length > 40 && !/stars on the stage and above it/i.test(d)) description = d.slice(0, 900);
		}

		const band = title.split(/\s+[–with|+]/i)[0].trim() || title;

		events.push({
			title,
			band,
			starts_at,
			image_url,
			artist_image_url: artistPhoto,
			image_kind: picked.kind || (artistPhoto ? "artist" : null),
			source_url: url,
			source_event_id: slug,
			raw_date_text: `${dateM[0]} ${times[0] || time}`,
			ticket_url: ticket?.replace(/&amp;/g, "&"),
			description,
			confidence: 0.93,
		});

		const file = decodeURIComponent((image_url || "").split("/").pop() || "").slice(0, 55);
		console.log(
			"✓",
			date,
			title.slice(0, 32).padEnd(32),
			picked.kind || "artist?",
			file,
		);
	} catch (e) {
		console.log("ERR", slug, e.message);
	}
}

events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(
	`\nReady ${events.length} images ${events.filter((e) => e.image_url).length} (event posters ${events.filter((e) => e.image_kind === "event").length}, artist ${events.filter((e) => e.image_kind === "artist").length})`,
);

if (!events.length) {
	console.error("No events");
	process.exit(1);
}

// ── Stage ──
const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id, name")
	.eq("site_id", site.id)
	.eq("slug", "germania-insurance-amphitheater")
	.single();

await sb
	.from("venues")
	.update({ calendar_url: CAL, website_url: ORIGIN + "/" })
	.eq("id", venue.id);

const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({
			platform_type: "germaniaamp",
			feed_url: CAL,
			calendar_url: CAL,
			updated_at: new Date().toISOString(),
		})
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "germaniaamp",
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

/** Rackcdn has invalid TLS — fetch over http, rehost to Supabase HTTPS. */
async function rehostImage(siteId, altText, imageUrl) {
	if (!imageUrl) return null;
	const fetchUrl = /rackcdn\.com/i.test(imageUrl)
		? imageUrl.replace(/^https:\/\//i, "http://")
		: imageUrl;
	try {
		const response = await fetch(fetchUrl, {
			headers: { "User-Agent": UA, Accept: "image/*,*/*" },
			redirect: "follow",
		});
		if (!response.ok) return null;
		const contentType = response.headers.get("content-type") ?? "image/jpeg";
		if (!contentType.startsWith("image/")) return null;
		const ext = contentType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ?? "jpg";
		const bytes = await response.arrayBuffer();
		const path = `${siteId}/germania/${createHash("sha1").update(imageUrl).digest("hex").slice(0, 16)}.${ext}`;
		const { error: uploadError } = await sb.storage
			.from("event-media")
			.upload(path, bytes, { contentType, upsert: true });
		if (uploadError) {
			console.log("  rehost fail", altText.slice(0, 30), uploadError.message);
			return null;
		}
		const {
			data: { publicUrl },
		} = sb.storage.from("event-media").getPublicUrl(path);
		return publicUrl;
	} catch (e) {
		console.log("  rehost err", e.message);
		return null;
	}
}

console.log("\nRe-hosting images to Supabase (HTTPS)…");
const venueName = "Germania Insurance Amphitheater";
const rows = [];
for (let i = 0; i < events.length; i++) {
	const e = events[i];
	const desc = e.description || hype(e.band, venueName, e.starts_at, i);
	const hosted = (await rehostImage(site.id, e.title, e.image_url)) || e.image_url;
	const artistHosted = e.artist_image_url
		? (await rehostImage(site.id, `${e.title} artist`, e.artist_image_url)) || e.artist_image_url
		: null;
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
		source_partner: "germaniaamp",
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
			artist_image_url: artistHosted,
			confidence: e.confidence,
			import_method: "feed",
			platform: "germaniaamp",
		},
	});
	console.log(" ", e.title.slice(0, 30), /supabase/i.test(hosted) ? "✓ hosted" : "⚠ source url");
}

const { error } = await sb.from("ingested_events").insert(rows);
if (error) throw new Error(error.message);

console.log(
	`\n=== Germania Insurance Amphitheater === staged ${rows.length} images ${rows.filter((r) => r.raw_payload.image_url).length}`,
);
console.log("Done → https://events-platform-admin.ben-745.workers.dev/ingestion");
