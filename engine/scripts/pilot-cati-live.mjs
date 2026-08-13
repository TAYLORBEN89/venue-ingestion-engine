/**
 * Come and Take It Live — full calendar pilot
 * https://comeandtakeitproductions.com/calendar/ filtered to venue "come-and-take-it-live"
 * Detail pages for image, description, etix ticket links, start ISO.
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
const CAL = "https://comeandtakeitproductions.com/calendar/";
const VENUE_SLUG = "come-and-take-it-live";
const VENUE_LABEL = "Come and Take It Live";

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
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
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
		const path = `${siteId}/cati-live/${randomUUID()}.${ext}`;
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

function parseListDate(text, yearHint = 2026) {
	// "Fri, Jul 10" or "Friday, July 10"
	const m = text.match(
		/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})/i,
	);
	if (!m) return null;
	const months = {
		jan: 1,
		feb: 2,
		mar: 3,
		apr: 4,
		may: 5,
		jun: 6,
		jul: 7,
		aug: 8,
		sep: 9,
		oct: 10,
		nov: 11,
		dec: 12,
	};
	const mo = months[m[1].toLowerCase().slice(0, 3)];
	const day = String(+m[2]).padStart(2, "0");
	// Assume yearHint; if month < current-1 and we're past mid-year, may be next year
	let year = yearHint;
	const now = new Date();
	if (mo < now.getMonth() - 1 && now.getMonth() >= 6) year = now.getFullYear() + 1;
	else if (yearHint === now.getFullYear() && mo < now.getMonth() + 1 && now.getMonth() >= 10) {
		// late year looking at early months → next year
		year = yearHint + 1;
	}
	return `${year}-${String(mo).padStart(2, "0")}-${day}`;
}

console.log("=== Come and Take It Live pilot ===\n");
const calHtml = await get(CAL);

// Split into event cards for this venue
const blocks = calHtml.split(/rhpSingleEvent|rhp-event__single-event/i).slice(1);
const fromList = [];
const seenUrl = new Set();
for (const block of blocks) {
	if (!/come-and-take-it-live/i.test(block)) continue;
	const href = block.match(
		/href="(https:\/\/comeandtakeitproductions\.com\/event\/[^"]+come-and-take-it-live\/?)"/i,
	)?.[1];
	if (!href || seenUrl.has(href)) continue;
	seenUrl.add(href);
	const title =
		stripHtml(block.match(/title="([^"]+)"/i)?.[1] || block.match(/alt='([^']+)'/i)?.[1] || "") ||
		null;
	const dateText = stripHtml(
		block.match(/eventDateListTop[\s\S]*?<div[^>]*>([^<]+)/i)?.[1] ||
			block.match(/eventMonth[^>]*>([^<]+)/i)?.[1] ||
			"",
	);
	const img =
		block.match(/src="(https:\/\/comeandtakeitproductions\.com\/wp-content\/uploads\/[^"]+)"/i)?.[1] ||
		null;
	const ticket = block.match(/href="(https:\/\/www\.etix\.com[^"]+)"/i)?.[1] || null;
	const date = parseListDate(dateText, 2026);
	if (!title || !date) continue;
	fromList.push({
		title,
		date,
		dateText,
		img,
		ticket,
		source_url: href.replace(/\/$/, "") + "/",
		source_event_id: href.replace("https://comeandtakeitproductions.com", "").replace(/\/$/, ""),
	});
}
console.log(`List cards for CATI Live: ${fromList.length}`);

const events = [];
let i = 0;
for (const item of fromList) {
	i++;
	// List card date is authoritative (ISO fields on RHP pages are often
	// modified/published timestamps, not showtime).
	let time = "20:00";
	let starts_at = localToUtc(`${item.date} ${time}:00`);
	let description = null;
	let image_url = item.img;
	let ticket_url = item.ticket || item.source_url;

	try {
		const d = await get(item.source_url);
		// Optional: doors/show time labels like "Doors 7:00 PM · Show 8:00 PM"
		const showTime = d.match(/(?:show|starts?)\s*(?:time)?[:\s]*(\d{1,2}):(\d{2})\s*(am|pm)/i);
		const doorsTime = d.match(/doors?\s*[:\s]*(\d{1,2}):(\d{2})\s*(am|pm)/i);
		const tMatch = showTime || doorsTime;
		if (tMatch) {
			let h = +tMatch[1];
			const ap = tMatch[3].toLowerCase();
			if (ap === "pm" && h < 12) h += 12;
			if (ap === "am" && h === 12) h = 0;
			time = `${String(h).padStart(2, "0")}:${tMatch[2]}`;
			starts_at = localToUtc(`${item.date} ${time}:00`);
		}
		// Prefer detail date label when present (same calendar day)
		const stDate = stripHtml(d.match(/eventStDate[^>]*>([^<]+)/i)?.[1] || "");
		const parsed = parseListDate(stDate, +item.date.slice(0, 4));
		if (parsed) starts_at = localToUtc(`${parsed} ${time}:00`);

		const rawDesc =
			stripHtml(
				d.match(/singleEventDescription[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
					d.match(/class="[^"]*eventDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
					d.match(/property="og:description"\s+content="([^"]+)"/i)?.[1] ||
					"",
			) || null;
		// Site often embeds CSS/theme junk in description blocks — never store that.
		const isJunk =
			!rawDesc ||
			rawDesc.length < 40 ||
			/widget-events|event-tagline|sidebarOnsale|eventWrapper|justAnnounced|font-weight\s*:|\.event-subheader/i.test(
				rawDesc,
			) ||
			(/[{};]/.test(rawDesc) && rawDesc.length > 80);
		if (!isJunk) description = rawDesc.slice(0, 3000);

		const img =
			d.match(/src="(https:\/\/comeandtakeitproductions\.com\/wp-content\/uploads\/202[5-9]\/[^"]+)"/i)?.[1] ||
			d.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ||
			image_url;
		if (img && !/logo/i.test(img)) image_url = img;

		const tix = d.match(/href="(https:\/\/www\.etix\.com[^"]+)"/i)?.[1];
		if (tix) ticket_url = tix.replace(/&amp;/g, "&");
	} catch (e) {
		console.log(`  detail fail ${item.title}: ${e.message}`);
	}

	if (+new Date(starts_at) < Date.now() - 864e5) continue;

	events.push({
		title: item.title,
		band: item.title.split(/[:–|]/)[0].trim(),
		starts_at,
		description,
		image_url,
		source_url: item.source_url,
		source_event_id: item.source_event_id,
		raw_date_text: item.dateText || item.date,
		ticket_url,
		confidence: 0.91,
	});

	if (i % 10 === 0 || i === fromList.length) {
		console.log(`  [${i}/${fromList.length}] ${item.title.slice(0, 40)}`);
	}
	await new Promise((r) => setTimeout(r, 100));
}

events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(`\nParsed ${events.length} upcoming CATI Live shows`);

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
let { data: venue } = await sb
	.from("venues")
	.select("id, name, slug")
	.eq("site_id", site.id)
	.or(`slug.eq.${VENUE_SLUG},name.ilike.%come and take it live%`)
	.limit(1)
	.maybeSingle();

if (!venue) {
	const { data: created, error } = await sb
		.from("venues")
		.insert({
			site_id: site.id,
			slug: VENUE_SLUG,
			name: VENUE_LABEL,
			website_url: "https://www.comeandtakeitlive.com/",
			calendar_url: CAL,
			address: "2015 E Riverside Dr, Austin, TX 78741",
			status: "published",
		})
		.select("id, name, slug")
		.single();
	if (error) throw new Error(error.message);
	venue = created;
	console.log("created", VENUE_SLUG);
} else {
	await sb
		.from("venues")
		.update({ calendar_url: CAL, website_url: "https://www.comeandtakeitlive.com/", updated_at: new Date().toISOString() })
		.eq("id", venue.id);
}

const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({ platform_type: "rhp_events", feed_url: CAL, calendar_url: CAL, updated_at: new Date().toISOString() })
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "rhp_events",
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
/** Generic clean copy — never store scraped CSS/theme text as description. */
function genericDesc(e) {
	const band = (e.band || e.title).trim();
	const date = formatShowDate(e.starts_at);
	const time = formatShowtime(e.starts_at);
	return `Catch ${band} live at ${VENUE_LABEL} on ${date}. Showtime around ${time}. Grab tickets and get there early.`;
}

const rows = [];
for (let j = 0; j < events.length; j++) {
	const e = events[j];
	const hosted = e.image_url ? await rehost(site.id, e.image_url) : null;
	// Always use generic venue intro (detail pages ship CSS, not real blurbs)
	const desc = genericDesc(e);
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
		source_partner: "rhp_events",
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
			import_method: "calendar_detail",
			platform: "rhp_events",
		},
	});
	if ((j + 1) % 10 === 0) console.log(`  rehost ${j + 1}/${events.length}`);
}

for (let j = 0; j < rows.length; j += 40) {
	const { error } = await sb.from("ingested_events").insert(rows.slice(j, j + 40));
	if (error) throw new Error(error.message);
}

console.log(
	`\n=== ${venue.name} === staged ${rows.length}  images ${rows.filter((r) => r.raw_payload.image_url).length}  etix ${rows.filter((r) => /etix/i.test(r.raw_payload.ticket_url || "")).length}`,
);
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
		e.title.slice(0, 48),
	);
}
console.log("\nDone → https://events-platform-admin.ben-745.workers.dev/ingestion");
