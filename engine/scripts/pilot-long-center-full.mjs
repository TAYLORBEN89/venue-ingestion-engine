/**
 * Long Center full pilot — upcoming-calendar → each event detail
 *
 * Workflow:
 *   1. https://thelongcenter.org/upcoming-calendar/
 *   2. #evcal_list .eventon_events_list → each .desc_trig /event/ link
 *   3. Detail page: background-image / data-f, .eventon_desc_in (full text;
 *      "more" is CSS-hidden, content is still in HTML), schema startDate, tickets
 *   4. Return to calendar list for next event
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
// Published HeyAustin venue (not archived long-center-merged-gobt)
const VENUE_SLUG = "the-long-center";
const VENUE_LABEL = "The Long Center";
const CAL = "https://thelongcenter.org/upcoming-calendar/";

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
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
		.replace(/&ldquo;|&rdquo;/gi, '"')
		.replace(/&lsquo;|&rsquo;/gi, "'")
		.replace(/&mdash;|&ndash;/gi, "—")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
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
function parseFlexibleStart(raw) {
	// "2026-7-16T20:00-5:00" (EventON style)
	const m = String(raw).match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
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
		headers: { "User-Agent": UA, Accept: "text/html,*/*" },
		redirect: "follow",
		signal: AbortSignal.timeout(30000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

async function rehost(siteId, imageUrl) {
	if (!imageUrl) return null;
	if (/supabase\.co\/storage/i.test(imageUrl)) return imageUrl;
	try {
		const r = await fetch(imageUrl, {
			headers: { "User-Agent": UA, Accept: "image/*,*/*" },
			redirect: "follow",
			signal: AbortSignal.timeout(30000),
		});
		if (!r.ok) return imageUrl;
		const contentType = r.headers.get("content-type") ?? "image/jpeg";
		if (!contentType.startsWith("image/")) return imageUrl;
		const ext = contentType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ?? "jpg";
		const bytes = await r.arrayBuffer();
		const path = `${siteId}/long-center/${randomUUID()}.${ext}`;
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

function extractListUrls(html) {
	const urls = new Set();
	// Prefer links inside the eventon list
	const list = html.match(/id="evcal_list"[\s\S]*?(?=<div[^>]+id="|$)/i)?.[0] || html;
	for (const m of list.matchAll(/href="(https:\/\/thelongcenter\.org\/events\/[^"#?]+)"/gi)) {
		const u = m[1].replace(/\/$/, "");
		if (/\/var\//i.test(u)) continue;
		urls.add(u);
	}
	for (const m of list.matchAll(/href="(\/events\/[^"#?]+)"/gi)) {
		const u = `https://thelongcenter.org${m[1].replace(/\/$/, "")}`;
		if (/\/var\//i.test(u)) continue;
		urls.add(u);
	}
	return [...urls];
}

function extractTicket(html, fallback) {
	const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) =>
		m[1].replace(/&amp;/g, "&"),
	);
	// Tessitura box office first (user walkthrough: my.thelongcenter.org/####)
	const tess = hrefs.find((h) => /my\.thelongcenter\.org\/\d+/i.test(h));
	if (tess) return tess.replace(/[?&]_ga=[^&]+/g, "").replace(/\?$/, "");
	const buy = hrefs.find((h) =>
		/ticket|purchase|buy.?ticket|eventbrite|axs\.com|ticketmaster|seetickets|etix|my\.thelongcenter\.org/i.test(
			h,
		),
	);
	return buy ? buy.replace(/[?&]_ga=[^&]+/g, "").replace(/\?$/, "") : fallback;
}

async function parseDetail(url) {
	const html = await get(url);
	// schema.org Event block
	let schema = null;
	for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
		try {
			const j = JSON.parse(m[1]);
			if (j["@type"] === "Event" || j.name) {
				schema = j;
				break;
			}
		} catch {
			/* continue */
		}
	}

	const title = stripHtml(
		schema?.name ||
			html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
			html.match(/property=["']og:title["']\s+content=["']([^"']+)/i)?.[1] ||
			"",
	)
		.replace(/\s*[|–-]\s*Long Center.*$/i, "")
		.trim();

	const startRaw =
		schema?.startDate ||
		html.match(/"startDate"\s*:\s*"([^"]+)"/)?.[1] ||
		html.match(/itemprop="startDate"[^>]*content="([^"]+)"/i)?.[1];
	const starts_at = startRaw ? parseFlexibleStart(startRaw) : null;

	// Full-size image: data-f on main image, schema image, or bg url (prefer non-thumbnail)
	let image_url =
		html.match(/evocard_main_image[^>]*data-f="(https?:\/\/[^"]+)"/i)?.[1] ||
		html.match(/data-f="(https?:\/\/thelongcenter\.org\/wp-content\/uploads\/[^"]+)"/i)?.[1] ||
		(typeof schema?.image === "string" ? schema.image : schema?.image?.url) ||
		html.match(/background-image:url\((https?:\/\/[^)]+)\)/i)?.[1]?.replace(/["']/g, "") ||
		html.match(/property=["']og:image["']\s+content=["']([^"']+)/i)?.[1] ||
		null;
	// Prefer full size over -300x169 thumbnails
	if (image_url) image_url = image_url.replace(/-\d+x\d+(\.[a-z]+)$/i, "$1");

	// Full description — Tessitura performance details, then EventON, then schema
	const descBlock =
		html.match(
			/class="[^"]*tn-event-detail__performance-details-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<\/section|<\/main)/i,
		)?.[1] ||
		html.match(
			/class="[^"]*tn-event-detail__performance-details[^"]*"[^>]*>([\s\S]{80,8000}?)<\/div>/i,
		)?.[1] ||
		html.match(/class="eventon_desc_in"[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/div>\s*<p class='eventon_shad_p'/i)?.[1] ||
		html.match(/class="eventon_desc_in"[^>]*>([\s\S]*?)<\/div>\s*<p class='eventon_shad_p'/i)?.[1] ||
		html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
		(typeof schema?.description === "string" ? schema.description : "") ||
		html.match(/property=["']og:description["']\s+content=["']([^"']+)/i)?.[1] ||
		"";
	let description = stripHtml(descBlock);
	// Drop leading "Event Details" heading residue
	description = description.replace(/^Event Details\s*/i, "").trim();
	if (description.length < 40) description = null;
	else description = description.slice(0, 4000);

	const ticket_url = extractTicket(html, url);

	return {
		title,
		starts_at,
		raw_date_text: startRaw || null,
		image_url,
		description,
		ticket_url,
		source_url: url,
		source_event_id: url.replace("https://thelongcenter.org", "").replace(/\/$/, ""),
	};
}

console.log("=== Long Center — upcoming-calendar full pilot ===\n");
const calHtml = await get(CAL);
const urls = extractListUrls(calHtml);
console.log(`Found ${urls.length} event links on calendar`);

const events = [];
const seen = new Set();
let i = 0;
for (const url of urls) {
	i++;
	try {
		const e = await parseDetail(url);
		if (!e.title || !e.starts_at) {
			console.log(`  [${i}/${urls.length}] skip no title/date ${url}`);
			continue;
		}
		if (+new Date(e.starts_at) < Date.now() - 864e5) {
			console.log(`  [${i}/${urls.length}] past ${e.title}`);
			continue;
		}
		const key = `${e.title}|${e.starts_at.slice(0, 16)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		events.push({
			...e,
			band: e.title.split(/[:–|,]/)[0].trim(),
			confidence: 0.93,
		});
		console.log(
			`  [${i}/${urls.length}] ${e.starts_at.slice(0, 10)} ${e.title.slice(0, 48)} ${e.image_url ? "🖼" : "·"} desc=${e.description?.length ?? 0}`,
		);
		await new Promise((r) => setTimeout(r, 120));
	} catch (err) {
		console.log(`  [${i}/${urls.length}] FAIL ${url}: ${err.message}`);
	}
}

events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(`\nParsed ${events.length} upcoming events`);

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
let { data: venue } = await sb
	.from("venues")
	.select("id, name, slug")
	.eq("site_id", site.id)
	.eq("slug", VENUE_SLUG)
	.maybeSingle();
if (!venue) {
	const { data: created, error } = await sb
		.from("venues")
		.insert({
			site_id: site.id,
			slug: VENUE_SLUG,
			name: VENUE_LABEL,
			website_url: "https://thelongcenter.org/",
			calendar_url: CAL,
			address: "701 W Riverside Dr, Austin, TX 78704",
			status: "published",
		})
		.select("id, name, slug")
		.single();
	if (error) throw new Error(error.message);
	venue = created;
	console.log("created venue", VENUE_SLUG);
} else {
	await sb
		.from("venues")
		.update({ calendar_url: CAL, updated_at: new Date().toISOString() })
		.eq("id", venue.id);
}

const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({
			platform_type: "eventon",
			feed_url: CAL,
			calendar_url: CAL,
			is_enabled: true,
			scrape_days_ahead: 180,
			publish_mode: "draft",
			timezone: "America/Chicago",
			last_scrape_status: "success",
			last_scrape_error: null,
			last_scrape_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		})
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "eventon",
		feed_url: CAL,
		calendar_url: CAL,
		is_enabled: true,
		scrape_days_ahead: 180,
		publish_mode: "draft",
		timezone: "America/Chicago",
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
for (let j = 0; j < events.length; j++) {
	const e = events[j];
	const hosted = e.image_url ? await rehost(site.id, e.image_url) : null;
	const desc =
		e.description ||
		`See ${e.title} at the Long Center for the Performing Arts.`;
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
		source_partner: "eventon",
		extracted_band_name: e.band,
		matched_artist_id: null,
		artist_match_status: "unmatched",
		match_status: "new",
		matched_event_id: null,
		review_status: "pending",
		raw_payload: {
			description: desc,
			event_intro: desc.slice(0, 400),
			ticket_url: e.ticket_url,
			image_url: hosted,
			source_image_url: e.image_url,
			confidence: e.confidence,
			import_method: "upcoming_calendar_detail",
			platform: "eventon",
		},
	});
	if ((j + 1) % 5 === 0) console.log(`  rehost ${j + 1}/${events.length}`);
}

for (let j = 0; j < rows.length; j += 40) {
	const { error } = await sb.from("ingested_events").insert(rows.slice(j, j + 40));
	if (error) throw new Error(error.message);
}

const imgs = rows.filter((r) => r.raw_payload.image_url).length;
const descs = rows.filter((r) => (r.raw_payload.description || "").length > 80).length;
console.log(`\n=== ${venue.name} === staged ${rows.length}  images ${imgs}  long_descs ${descs}`);
for (const e of events.slice(0, 8)) {
	console.log(
		" ",
		new Date(e.starts_at).toLocaleString("en-US", {
			timeZone: TZ,
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}),
		e.title.slice(0, 50),
	);
}
console.log("\nAdmin → https://events-platform-admin.ben-745.workers.dev/ingestion");
