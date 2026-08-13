/**
 * Flamingo Cantina — TEC list crawl pilot (per product walkthrough)
 *
 * 1. https://flamingocantina.com/calendar/list/
 * 2. ul.tribe-events-calendar-list → event title links
 * 3. Detail page: image (wp-image / uploads), description <p>…</p>, YouTube
 * 4. tribe-events-c-nav__next → next list page until exhausted
 *
 * Stages + publishes to venue slug flamingo-cantina.
 *
 * Run from apps/ingestion:
 *   node scripts/pilot-flamingo-cantina.mjs
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
const LIST_URL = "https://flamingocantina.com/calendar/list/";
const VENUE_SLUG = "flamingo-cantina";
const VENUE_LABEL = "Flamingo Cantina";
const MAX_LIST_PAGES = 20;

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
		.replace(/&#8216;|&#8217;/g, "'")
		.replace(/&#8211;|&#8212;/g, "–")
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function absUrl(href, base = LIST_URL) {
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
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

function formatShowDate(iso) {
	return new Date(iso).toLocaleDateString("en-US", {
		timeZone: TZ,
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}

function formatShowtime(iso) {
	return new Date(iso).toLocaleTimeString("en-US", {
		timeZone: TZ,
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
		redirect: "follow",
		signal: AbortSignal.timeout(30000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

async function rehost(siteId, imageUrl) {
	if (!imageUrl) return null;
	if (/supabase\.co\/storage/i.test(imageUrl)) return imageUrl;
	const httpsUrl = imageUrl.replace(/^http:\/\//i, "https://");
	try {
		const r = await fetch(httpsUrl, {
			headers: { "User-Agent": UA, Accept: "image/*,*/*" },
			redirect: "follow",
			signal: AbortSignal.timeout(30000),
		});
		if (!r.ok) return httpsUrl;
		const contentType = r.headers.get("content-type") ?? "image/jpeg";
		if (!contentType.startsWith("image/")) return httpsUrl;
		const ext = contentType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ?? "jpg";
		const bytes = await r.arrayBuffer();
		const path = `${siteId}/flamingo/${randomUUID()}.${ext}`;
		const { error } = await sb.storage.from("event-media").upload(path, bytes, {
			contentType,
			upsert: false,
		});
		if (error) return httpsUrl;
		const { data } = sb.storage.from("event-media").getPublicUrl(path);
		return data.publicUrl;
	} catch {
		return httpsUrl;
	}
}

/** List page: links inside ul.tribe-events-calendar-list */
function extractListEvents(html) {
	const listBlock =
		html.match(/<ul[^>]*class="[^"]*tribe-events-calendar-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)?.[1] ?? html;

	const items = [];
	const seen = new Set();

	// Prefer title-link anchors (walkthrough selector)
	const patterns = [
		/<a[^>]*class="[^"]*tribe-events-calendar-list__event-title-link[^"]*"[^>]*href="([^"]+)"[^>]*(?:title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/gi,
		/<a[^>]*href="([^"]+)"[^>]*class="[^"]*tribe-events-calendar-list__event-title-link[^"]*"[^>]*(?:title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/gi,
	];

	for (const re of patterns) {
		for (const m of listBlock.matchAll(re)) {
			const href = absUrl(m[1]);
			if (!/\/event\//i.test(href)) continue;
			const key = href.replace(/\/$/, "");
			if (seen.has(key)) continue;
			seen.add(key);
			const title = stripHtml(m[2] || m[3] || "");
			if (!title) continue;
			items.push({ url: href.endsWith("/") ? href : `${href}/`, title });
		}
	}

	// Fallback: any /event/ links in the list block
	if (items.length === 0) {
		for (const m of listBlock.matchAll(/href="(https?:\/\/[^"]+\/event\/[^"#?]+)"/gi)) {
			const href = absUrl(m[1]);
			const key = href.replace(/\/$/, "");
			if (seen.has(key)) continue;
			seen.add(key);
			items.push({ url: href.endsWith("/") ? href : `${href}/`, title: key.split("/").filter(Boolean).pop() });
		}
	}

	return items;
}

function extractNextListUrl(html, currentUrl) {
	const patterns = [
		/class="[^"]*tribe-events-c-nav__next[^"]*"[^>]*href="([^"]+)"/i,
		/href="([^"]+)"[^>]*class="[^"]*tribe-events-c-nav__next[^"]*"/i,
		// label span is inside the next link
		/<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?tribe-events-c-nav__next-label/i,
	];
	for (const re of patterns) {
		const m = html.match(re);
		if (m?.[1] && !/disabled|aria-disabled="true"/i.test(m[0])) {
			return absUrl(m[1], currentUrl);
		}
	}
	return null;
}

function extractYoutube(html) {
	const id =
		html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i)?.[1] ||
		html.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i)?.[1] ||
		html.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i)?.[1] ||
		html.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i)?.[1] ||
		// lite-youtube / data attributes
		html.match(/data-id="([a-zA-Z0-9_-]{11})"/i)?.[1] ||
		html.match(/data-video-id="([a-zA-Z0-9_-]{11})"/i)?.[1];
	if (!id) return { youtube_id: null, youtube_embed: null };
	return {
		youtube_id: id,
		youtube_embed: `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`,
	};
}

function extractImage(html) {
	const candidates = [
		html.match(/class="[^"]*wp-image-\d+[^"]*"[^>]*src="([^"]+)"/i)?.[1],
		html.match(/src="([^"]+)"[^>]*class="[^"]*wp-image-\d+/i)?.[1],
		html.match(/class="[^"]*wp-post-image[^"]*"[^>]*src="([^"]+)"/i)?.[1],
		html.match(/src="([^"]+)"[^>]*class="[^"]*wp-post-image/i)?.[1],
		html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1],
		html.match(/src="(https?:\/\/flamingocantina\.com\/wp-content\/uploads\/[^"]+\.(?:jpe?g|png|webp))"/i)?.[1],
	].filter(Boolean);

	for (const raw of candidates) {
		const u = String(raw).replace(/^http:\/\//i, "https://");
		if (/logo|icon|avatar|sprite|emoji/i.test(u)) continue;
		// Prefer full-size over -792x1024 when possible
		const full = u.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, "$1");
		return full;
	}
	return null;
}

function extractDescription(html) {
	// Prefer TEC single event description block
	const blocks = [
		html.match(/class="[^"]*tribe-events-single-event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1],
		html.match(/class="[^"]*tribe-events-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1],
		html.match(/class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1],
	].filter(Boolean);

	const body = blocks[0] || "";
	const paragraphs = [...(body || html).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((m) => stripHtml(m[1]))
		.filter((t) => {
			if (t.length < 25) return false;
			if (/^@?\s*Tickets/i.test(t)) return false;
			if (/Join on Facebook|cookie|subscribe|newsletter|privacy/i.test(t)) return false;
			// Skip pure datetime lines like "July 10 @ 8:30 pm – July 11 @ 2:00 am"
			if (/^[A-Z][a-z]+ \d{1,2}\s*@/i.test(t) && t.length < 80) return false;
			return true;
		});

	if (paragraphs.length) return paragraphs.join("\n\n").slice(0, 4000);
	const stripped = stripHtml(body);
	return stripped.length > 40 ? stripped.slice(0, 4000) : null;
}

function extractTimes(html, pageUrl) {
	// JSON-LD schema startDate / endDate
	const startLd = html.match(/"startDate"\s*:\s*"([^"]+)"/i)?.[1];
	const endLd = html.match(/"endDate"\s*:\s*"([^"]+)"/i)?.[1];
	if (startLd) {
		const s = new Date(startLd);
		if (!Number.isNaN(s.getTime())) {
			const e = endLd ? new Date(endLd) : null;
			return {
				starts_at: s.toISOString(),
				ends_at: e && !Number.isNaN(e.getTime()) ? e.toISOString() : null,
				raw_date_text: `${startLd}${endLd ? ` – ${endLd}` : ""}`,
			};
		}
	}

	// tribe datetime attributes
	const dtStart =
		html.match(/tribe-event-date-start[^>]*datetime="([^"]+)"/i)?.[1] ||
		html.match(/datetime="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^"]*)"/i)?.[1];
	const dtEnd = html.match(/tribe-event-date-end[^>]*datetime="([^"]+)"/i)?.[1];
	if (dtStart) {
		const s = new Date(dtStart);
		if (!Number.isNaN(s.getTime())) {
			const e = dtEnd ? new Date(dtEnd) : null;
			return {
				starts_at: s.toISOString(),
				ends_at: e && !Number.isNaN(e.getTime()) ? e.toISOString() : null,
				raw_date_text: dtStart,
			};
		}
	}

	// URL slug 2026-july10 + default 8pm
	const slug = pageUrl.match(/\/event\/(\d{4})-([a-z]+)(\d{1,2})\//i);
	if (slug) {
		const months = {
			january: "01",
			february: "02",
			march: "03",
			april: "04",
			may: "05",
			june: "06",
			july: "07",
			august: "08",
			september: "09",
			october: "10",
			november: "11",
			december: "12",
		};
		const mon = months[slug[2].toLowerCase()];
		if (mon) {
			const day = String(+slug[3]).padStart(2, "0");
			const wall = `${slug[1]}-${mon}-${day} 20:00:00`;
			return { starts_at: localToUtc(wall), ends_at: null, raw_date_text: wall };
		}
	}

	return null;
}

function extractPrice(html) {
	const cost =
		stripHtml(html.match(/tribe-events-cost[^>]*>([\s\S]*?)<\//i)?.[1] || "") ||
		stripHtml(html.match(/"price"\s*:\s*"([^"]+)"/i)?.[1] || "") ||
		html.match(/Cost:\s*([^\n<]+)/i)?.[1];
	if (!cost) return null;
	const t = cost.trim();
	if (!t || /tba|n\/a/i.test(t)) return null;
	return t;
}

function extractTicketUrl(html, pageUrl) {
	const tix =
		html.match(/href="(https?:\/\/[^"]*(?:etix|ticketmaster|axs|eventbrite|seetickets)[^"]*)"/i)?.[1] ||
		html.match(/href="([^"]+)"[^>]*>[\s\S]{0,40}Tickets/i)?.[1];
	return tix ? absUrl(tix, pageUrl) : pageUrl;
}

async function parseDetail(item) {
	const html = await get(item.url);
	const title =
		stripHtml(
			html.match(/tribe-events-single-event-title[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
				html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] ||
				item.title,
		) || item.title;

	const times = extractTimes(html, item.url);
	if (!times) {
		console.log("  skip no date", title);
		return null;
	}
	if (+new Date(times.starts_at) < Date.now() - 864e5) return null;

	const image_url = extractImage(html);
	const description = extractDescription(html);
	const yt = extractYoutube(html);
	const price_text = extractPrice(html);
	const ticket_url = extractTicketUrl(html, item.url);

	const band = title.split(/[,&]| w\/ | with /i)[0].trim() || title;

	return {
		title,
		band,
		starts_at: times.starts_at,
		ends_at: times.ends_at,
		raw_date_text: times.raw_date_text,
		description,
		image_url,
		source_url: item.url,
		source_event_id: item.url.replace(/\/$/, "").split("/").pop(),
		ticket_url,
		price_text,
		youtube_id: yt.youtube_id,
		youtube_embed: yt.youtube_embed,
		confidence: 0.93,
	};
}

// ───────── crawl ─────────
console.log("=== Flamingo Cantina list crawl ===\n");

const listItems = [];
const seenUrls = new Set();
let pageUrl = LIST_URL;
for (let page = 1; page <= MAX_LIST_PAGES; page++) {
	console.log(`List page ${page}: ${pageUrl}`);
	const html = await get(pageUrl);
	const batch = extractListEvents(html);
	console.log(`  found ${batch.length} title links`);
	for (const it of batch) {
		const key = it.url.replace(/\/$/, "");
		if (seenUrls.has(key)) continue;
		seenUrls.add(key);
		listItems.push(it);
	}
	const next = extractNextListUrl(html, pageUrl);
	if (!next || next === pageUrl) break;
	// avoid loops
	if (seenUrls.has(`list:${next}`)) break;
	seenUrls.add(`list:${next}`);
	pageUrl = next;
	await new Promise((r) => setTimeout(r, 200));
}

console.log(`\nTotal list links: ${listItems.length}`);
console.log("Visiting detail pages…");

const events = [];
for (let i = 0; i < listItems.length; i++) {
	const it = listItems[i];
	try {
		const e = await parseDetail(it);
		if (e) {
			events.push(e);
			console.log(
				`  [${i + 1}/${listItems.length}] ${formatShowDate(e.starts_at)} ${e.title.slice(0, 42)}${e.youtube_id ? " 🎬" : ""}${e.image_url ? " 🖼" : ""}`,
			);
		}
	} catch (err) {
		console.log(`  detail fail ${it.url}: ${err.message}`);
	}
	await new Promise((r) => setTimeout(r, 150));
}

events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(`\nParsed ${events.length} upcoming shows`);

// ───────── stage ─────────
const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
if (!site) throw new Error("heyaustin site missing");

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
			website_url: "https://flamingocantina.com/",
			calendar_url: LIST_URL,
			address: "515 E 6th St, Austin, TX 78701",
			status: "published",
		})
		.select("id, name, slug")
		.single();
	if (error) throw error;
	venue = created;
	console.log("created venue", VENUE_SLUG);
} else {
	await sb
		.from("venues")
		.update({
			calendar_url: LIST_URL,
			website_url: "https://flamingocantina.com/",
			updated_at: new Date().toISOString(),
		})
		.eq("id", venue.id);
}

// Source config for nightly TEC / list crawls
const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({
			platform_type: "tec",
			calendar_url: LIST_URL,
			feed_url: "https://flamingocantina.com/wp-json/tribe/events/v1/events",
			publish_mode: "auto_publish",
			is_enabled: true,
			scrape_days_ahead: 120,
			updated_at: new Date().toISOString(),
		})
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "tec",
		calendar_url: LIST_URL,
		feed_url: "https://flamingocantina.com/wp-json/tribe/events/v1/events",
		publish_mode: "auto_publish",
		is_enabled: true,
		scrape_days_ahead: 120,
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
	const showtime = formatShowtime(e.starts_at);
	const showDate = formatShowDate(e.starts_at);
	const desc =
		e.description ||
		`Catch ${e.band} live at ${VENUE_LABEL} on ${showDate}. Showtime around ${showtime}. Grab tickets and get there early.`;
	const intro = (e.description ? e.description.slice(0, 400) : desc).trim();

	rows.push({
		ingestion_run_id: run.id,
		venue_id: venue.id,
		raw_title: e.title,
		raw_date_text: e.raw_date_text,
		parsed_starts_at: e.starts_at,
		parsed_ends_at: e.ends_at,
		source_url: e.source_url,
		source_event_id: e.source_event_id,
		fingerprint: fp(e.title, e.starts_at, e.ticket_url),
		source_partner: "tec",
		extracted_band_name: e.band,
		matched_artist_id: null,
		artist_match_status: "unmatched",
		match_status: "new",
		matched_event_id: null,
		review_status: "pending",
		raw_payload: {
			description: desc,
			event_intro: intro,
			ticket_url: e.ticket_url,
			price_text: e.price_text,
			image_url: hosted,
			source_image_url: e.image_url,
			youtube_id: e.youtube_id,
			youtube_embed: e.youtube_embed,
			confidence: e.confidence,
			import_method: "list_detail_crawl",
			platform: "tec",
		},
	});
	if ((j + 1) % 8 === 0) console.log(`  rehost ${j + 1}/${events.length}`);
}

for (let i = 0; i < rows.length; i += 40) {
	const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
	if (error) throw new Error(error.message);
}

console.log(`\nStaged ${rows.length} pending events for ${VENUE_LABEL}`);

// ───────── publish (upsert by source_event_id / fingerprint) ─────────
function slugify(text) {
	return text
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 60);
}

function eventSlug(title, startsAtIso) {
	const at = new Date(startsAtIso);
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: TZ,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		})
			.formatToParts(at)
			.filter((p) => p.type !== "literal")
			.map((p) => [p.type, p.value]),
	);
	let hour = parts.hour ?? "00";
	if (hour === "24") hour = "00";
	return `${slugify(title) || "event"}-${parts.year}-${parts.month}-${parts.day}-${hour}${parts.minute ?? "00"}`;
}

let published = 0;
let updated = 0;
for (const row of rows) {
	const payload = row.raw_payload;
	let existing = null;
	{
		const { data: bySource } = await sb
			.from("events")
			.select("id")
			.eq("venue_id", venue.id)
			.eq("source_event_id", row.source_event_id)
			.maybeSingle();
		existing = bySource;
	}
	if (!existing) {
		const { data: byFp } = await sb
			.from("events")
			.select("id")
			.eq("venue_id", venue.id)
			.eq("fingerprint", row.fingerprint)
			.maybeSingle();
		existing = byFp;
	}

	const eventFields = {
		title: row.raw_title,
		description: payload.description,
		event_intro: payload.event_intro,
		starts_at: row.parsed_starts_at,
		ends_at: row.parsed_ends_at,
		ticket_url: payload.ticket_url,
		price_text: payload.price_text,
		source: "partner_import",
		source_event_id: row.source_event_id,
		fingerprint: row.fingerprint,
		status: "published",
		youtube_id: payload.youtube_id,
		youtube_embed: payload.youtube_embed,
		seo_title: `${row.raw_title.split(/[,:]/)[0].trim()} | ${VENUE_LABEL}`.slice(0, 60),
		seo_description: (payload.event_intro || payload.description || "").slice(0, 156),
		focus_keyphrase: `${row.extracted_band_name} Austin`.slice(0, 80),
		updated_at: new Date().toISOString(),
	};

	// attach media if we rehosted
	if (payload.image_url && /supabase\.co\/storage/i.test(payload.image_url)) {
		// ensure media row exists
		const { data: media } = await sb
			.from("media")
			.select("id")
			.eq("storage_path", payload.image_url)
			.maybeSingle();
		if (media?.id) {
			eventFields.featured_media_id = media.id;
		} else {
			const { data: createdMedia } = await sb
				.from("media")
				.insert({
					site_id: site.id,
					storage_path: payload.image_url,
					alt_text: row.raw_title,
				})
				.select("id")
				.single();
			if (createdMedia?.id) eventFields.featured_media_id = createdMedia.id;
		}
	}

	if (existing?.id) {
		await sb.from("events").update(eventFields).eq("id", existing.id);
		await sb
			.from("ingested_events")
			.update({
				review_status: "approved",
				reviewed_at: new Date().toISOString(),
				matched_event_id: existing.id,
				match_status: "matched_existing",
			})
			.eq("fingerprint", row.fingerprint)
			.eq("venue_id", venue.id)
			.eq("review_status", "pending");
		updated++;
	} else {
		const baseSlug = eventSlug(row.raw_title, row.parsed_starts_at);
		let created = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			const trySlug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
			const { data, error } = await sb
				.from("events")
				.insert({
					...eventFields,
					site_id: site.id,
					venue_id: venue.id,
					slug: trySlug,
					ingested_event_id: null,
				})
				.select("id")
				.single();
			if (!error && data) {
				created = data;
				break;
			}
			if (error && !/duplicate|unique/i.test(error.message)) {
				console.error("insert fail", row.raw_title, error.message);
				break;
			}
		}
		if (created) {
			await sb
				.from("ingested_events")
				.update({
					review_status: "approved",
					reviewed_at: new Date().toISOString(),
					matched_event_id: created.id,
				})
				.eq("fingerprint", row.fingerprint)
				.eq("venue_id", venue.id)
				.eq("review_status", "pending");
			published++;
		}
	}
}

console.log(`\nPublished new: ${published}, updated existing: ${updated}`);
console.log(`Venue page → /venues/${VENUE_SLUG}`);
console.log("Done.");
