/**
 * ACL Live 3TEN room calendar pilot (6 months out)
 * Stages into the combined venue: ACL Live at the Moody Theater (acl-live).
 *
 * Browser workflow the site uses:
 *   1. https://www.acllive.com/full-calendar  (JS calendar grid)
 *   2. Click days with hasEvent → event links
 *   3. Event detail: description_inner / img-responsive (AXS images)
 *   4. Next month arrow × 6 months
 *
 * The full-calendar grid is client-rendered (empty SSR shell). The same
 * event inventory is available server-side via monthly filtered listings:
 *   /events/filtered/{year}/{MonthName}  with data-venue="3" = 3TEN
 * We walk 6 months, then enrich each show from its /event/... detail page.
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
// Combined venue (Moody Theater + 3TEN rooms share one listing)
const VENUE_SLUG = "acl-live";
const VENUE_LABEL = "ACL Live at the Moody Theater";
/** data-venue id for 3TEN on acllive.com listings */
const TEN_VENUE_ID = "3";
const MONTHS_OUT = 6;

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
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
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

async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
		redirect: "follow",
		signal: AbortSignal.timeout(30000),
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
			signal: AbortSignal.timeout(30000),
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

/** Next N calendar months as { year, monthName } starting from current month. */
function monthsAhead(n) {
	const names = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const out = [];
	const now = new Date();
	for (let i = 0; i < n; i++) {
		const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
		out.push({ year: d.getFullYear(), monthName: names[d.getMonth()] });
	}
	return out;
}

function parseStartsFromPath(path) {
	// /event/2026-07-11-the-english-channels-at-8-pm
	const iso = path.match(
		/\/event\/(\d{4})-(\d{2})-(\d{2})-(.+?)(?:-at-(\d{1,2})-(\d{2})-?(am|pm))?$/i,
	);
	if (!iso) return null;
	const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
	let time = "20:00";
	if (iso[5] && iso[6]) {
		let h = +iso[5];
		const ap = (iso[7] || "pm").toLowerCase();
		if (ap === "pm" && h < 12) h += 12;
		if (ap === "am" && h === 12) h = 0;
		time = `${String(h).padStart(2, "0")}:${iso[6]}`;
	}
	return { date, time, starts_at: localToUtc(`${date} ${time}:00`), raw_date_text: `${date} ${time}` };
}

/**
 * Parse one month listing. Each eventItem has data-venue, thumb link + img, title.
 * Mirrors clicking calendar cells: only days with events appear as list cards.
 */
function parseMonthListing(html, venueId) {
	const items = [];
	// Split on eventItem blocks
	const blocks = html.split(/class="eventItem[^"]*"/i).slice(1);
	for (const block of blocks) {
		const venue = block.match(/data-venue="(\d+)"/i)?.[1];
		if (venue !== venueId) continue;
		const path =
			block.match(/href="https?:\/\/www\.acllive\.com(\/event\/[^"#?]+)"/i)?.[1] ||
			block.match(/href="(\/event\/[^"#?]+)"/i)?.[1];
		if (!path || !/\/event\/\d{4}-\d{2}-\d{2}-/i.test(path)) continue;
		const title =
			stripHtml(
				block.match(/title="More Info for ([^"]+)"/i)?.[1] ||
					block.match(/class="title[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
					"",
			) || null;
		if (!title || /premium pass|pnc hall/i.test(title)) continue;
		const img =
			block.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i)?.[1] ||
			block.match(/src="(https:\/\/images\.discovery-prod\.axs\.com[^"]+)"/i)?.[1] ||
			null;
		const location = stripHtml(block.match(/class="location"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
		items.push({ path: path.replace(/\/$/, ""), title, img, location });
	}
	return items;
}

async function enrichDetail(path) {
	const url = path.startsWith("http") ? path : `https://www.acllive.com${path}`;
	try {
		const html = await get(url);
		const descRaw =
			html.match(/class="[^"]*description_inner[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
			html.match(/class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
			html.match(/property="og:description" content="([^"]+)"/i)?.[1] ||
			"";
		const description = stripHtml(descRaw) || null;
		const image_url =
			html.match(/property="og:image" content="([^"]+)"/i)?.[1] ||
			html.match(/class="[^"]*img-responsive[^"]*"[^>]*src="([^"]+)"/i)?.[1] ||
			html.match(/data-image="(https?:\/\/[^"]+)"/i)?.[1] ||
			html.match(/src="(https:\/\/images\.discovery-prod\.axs\.com[^"]+)"/i)?.[1] ||
			null;
		// Confirm 3TEN on detail when possible
		const is3ten = /3TEN|3ten/i.test(html);
		return { description, image_url, is3ten, source_url: url };
	} catch (e) {
		return { description: null, image_url: null, is3ten: true, source_url: url, error: e.message };
	}
}

async function scrape3tenFullCalendar() {
	const months = monthsAhead(MONTHS_OUT);
	console.log("Months:", months.map((m) => `${m.monthName} ${m.year}`).join(", "));

	const byPath = new Map();
	for (const { year, monthName } of months) {
		const url = `https://www.acllive.com/events/filtered/${year}/${monthName}`;
		let html;
		try {
			html = await get(url);
		} catch (e) {
			console.log(`  ${monthName} ${year}: FAIL ${e.message}`);
			continue;
		}
		const items = parseMonthListing(html, TEN_VENUE_ID);
		let added = 0;
		for (const it of items) {
			if (byPath.has(it.path)) continue;
			const parsed = parseStartsFromPath(it.path);
			if (!parsed) continue;
			if (+new Date(parsed.starts_at) < Date.now() - 864e5) continue;
			byPath.set(it.path, {
				title: it.title,
				band: it.title,
				starts_at: parsed.starts_at,
				raw_date_text: parsed.raw_date_text,
				image_url: it.img,
				source_url: `https://www.acllive.com${it.path}`,
				source_event_id: it.path,
				ticket_url: `https://www.acllive.com${it.path}`,
				location: it.location,
				confidence: 0.93,
			});
			added++;
		}
		console.log(`  ${monthName} ${year}: ${items.length} 3TEN cards, +${added} new (total ${byPath.size})`);
	}

	const list = [...byPath.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	console.log(`\nEnriching ${list.length} event detail pages…`);
	let i = 0;
	for (const e of list) {
		i++;
		const path = e.source_event_id;
		const detail = await enrichDetail(path);
		if (detail.description) e.description = detail.description;
		if (detail.image_url) e.image_url = detail.image_url;
		if (detail.error) console.log(`  [${i}/${list.length}] detail fail ${path}: ${detail.error}`);
		else if (i % 5 === 0 || i === list.length) {
			console.log(`  [${i}/${list.length}] ${e.title.slice(0, 40)} ${e.image_url ? "🖼" : "·"}`);
		}
		// light polite delay
		await new Promise((r) => setTimeout(r, 120));
	}
	return list;
}

async function stage(events) {
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
				website_url: "https://www.3tenaustin.com/",
				calendar_url: "https://www.acllive.com/full-calendar",
				address: "310 Willie Nelson Blvd, Austin, TX 78701",
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
			.update({
				calendar_url: "https://www.acllive.com/full-calendar",
				website_url: "https://www.3tenaustin.com/",
				updated_at: new Date().toISOString(),
			})
			.eq("id", venue.id);
	}

	const calendarUrl = "https://www.acllive.com/full-calendar";
	const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
	if (sources?.[0]) {
		await sb
			.from("venue_event_sources")
			.update({
				platform_type: "axs",
				feed_url: calendarUrl,
				calendar_url: calendarUrl,
				updated_at: new Date().toISOString(),
			})
			.eq("id", sources[0].id);
	} else {
		await sb.from("venue_event_sources").insert({
			venue_id: venue.id,
			platform_type: "axs",
			feed_url: calendarUrl,
			calendar_url: calendarUrl,
			is_enabled: true,
		});
	}

	// Replace pending set for this venue
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
		const desc = e.description || hype(band, VENUE_LABEL, e.starts_at, i);
		const hosted = e.image_url ? await rehost(site.id, "acl-3ten", e.image_url) : null;
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
			source_partner: "axs",
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
				confidence: e.confidence ?? 0.93,
				import_method: "full_calendar_6mo",
				platform: "axs",
				calendar: "acllive.com/full-calendar",
			},
		});
		if ((i + 1) % 8 === 0) console.log(`  rehost ${i + 1}/${events.length}`);
	}

	for (let i = 0; i < rows.length; i += 40) {
		const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
		if (error) throw new Error(`insert: ${error.message}`);
	}

	const imgs = rows.filter((r) => r.raw_payload.image_url).length;
	const descs = rows.filter((r) => r.raw_payload.description && !r.raw_payload.description.startsWith("Catch ")).length;
	console.log(`\n=== ${venue.name} === staged ${rows.length}  images ${imgs}  real_descs ~${descs}`);
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
			e.title.slice(0, 52),
			e.image_url ? "🖼" : "·",
		);
	}
	if (events.length > 8) console.log(`  … +${events.length - 8} more`);
	return rows.length;
}

console.log("=== ACL Live (3TEN room) → acl-live combined venue — 6 months ===\n");
const events = await scrape3tenFullCalendar();
console.log(`\nParsed ${events.length} unique 3TEN-room shows`);
const n = await stage(events);
console.log(`\nDone — staged ${n} into ACL Live at the Moody Theater (acl-live)`);
console.log("Admin → https://events-platform-admin.ben-745.workers.dev/ingestion");
