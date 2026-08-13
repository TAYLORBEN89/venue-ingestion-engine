/**
 * ACL Live full events list pilot — infinite scroll (Moody + 3TEN as one venue)
 *
 * Source: https://www.acllive.com/events
 * Load-more AJAX (same as scrolling the page):
 *   GET /events/events_ajax/{offset}?category=0&venue=0&per_page=12&came_from_page=event-list-page
 * Each chunk is a JSON-encoded HTML string of .eventItem cards with:
 *   data-venue, .location (3TEN / Moody Theater / PBS), title, thumb, /event/... link
 *
 * Then each event detail page for description + AXS image.
 *
 * Stages all public rooms into one venue:
 *   - ACL Live at 3TEN  → acl-live (ACL Live at the Moody Theater)
 *   - ACL Live at The Moody Theater → acl-live
 *   - Austin PBS Tapings → skipped (not a public ticketed room we map yet)
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
const INCREMENT = 12;

/** Single canonical venue for both Moody Theater and 3TEN rooms. */
const ACL_LIVE_VENUE = {
	slug: "acl-live",
	name: "ACL Live at the Moody Theater",
	website_url: "https://www.acllive.com/",
	address: "310 W Willie Nelson Blvd, Austin, TX 78701, USA",
};

const VENUE_MAP = {
	"ACL Live at 3TEN": ACL_LIVE_VENUE,
	"ACL Live at The Moody Theater": ACL_LIVE_VENUE,
	"ACL Live at the Moody Theater": ACL_LIVE_VENUE,
};

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

function unesc(s) {
	return String(s).replace(/\\\//g, "/").replace(/\\"/g, '"').replace(/\\n/g, "\n");
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

/** Infinite-scroll page — same endpoint the browser hits on scroll. */
async function ajaxListPage(offset, venue = 0) {
	const u = new URL(`https://www.acllive.com/events/events_ajax/${offset}`);
	u.searchParams.set("category", "0");
	u.searchParams.set("venue", String(venue));
	u.searchParams.set("team", "0");
	u.searchParams.set("exclude", "");
	u.searchParams.set("per_page", String(INCREMENT));
	u.searchParams.set("came_from_page", "event-list-page");
	const r = await fetch(u, {
		headers: {
			"User-Agent": UA,
			Accept: "application/json, text/javascript, */*; q=0.01",
			"X-Requested-With": "XMLHttpRequest",
			Referer: "https://www.acllive.com/events",
		},
		signal: AbortSignal.timeout(30000),
	});
	const text = await r.text();
	if (!text || text.trim() === '""' || text.trim() === "[]" || text.trim() === "") return "";
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return unesc(text);
	}
	if (typeof parsed === "string") return unesc(parsed);
	if (Array.isArray(parsed)) return unesc(parsed.join("\n"));
	if (parsed && typeof parsed === "object") return unesc(Object.values(parsed).join("\n"));
	return "";
}

function parseListItems(html) {
	const out = [];
	const blocks = html.split(/class="eventItem[^"]*"/i).slice(1);
	for (const block of blocks) {
		const venueId = block.match(/data-venue="(\d+)"/i)?.[1] || null;
		const path = (
			block.match(/href="https?:\/\/www\.acllive\.com(\/event\/[^"#?]+)"/i)?.[1] ||
			block.match(/href="(\/event\/[^"#?]+)"/i)?.[1] ||
			""
		).replace(/\\/g, "");
		if (!path) continue;
		const title = stripHtml(
			block.match(/title="More Info for ([^"]+)"/i)?.[1] ||
				block.match(/class="title[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
				"",
		);
		if (!title || /premium pass|pnc hall/i.test(title)) continue;
		const location = stripHtml(block.match(/class="location"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
		const tagline = stripHtml(block.match(/class="tagline"[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || "");
		const img =
			block.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i)?.[1] ||
			block.match(/src="(https:\/\/images\.discovery-prod\.axs\.com[^"]+)"/i)?.[1] ||
			null;
		// Date spans when present: July 11, 2026 or Aug 22-23, 2026
		const dateText = stripHtml(
			block.match(/class="m-date__singleDate"[^>]*>([\s\S]*?)<\/span>\s*<\/a>/i)?.[1] ||
				block.match(/class="date"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
				"",
		);
		out.push({ path, title, location, tagline, img, venueId, dateText });
	}
	return out;
}

function parseStartsFromPath(path) {
	// -at-8-pm OR -at-8-30-pm OR -at-6-pm
	const iso = path.match(
		/\/event\/(\d{4})-(\d{2})-(\d{2})-(.+?)(?:-at-(\d{1,2})(?:-(\d{2}))?-?(am|pm))?$/i,
	);
	if (!iso) return null;
	const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
	let time = "20:00";
	if (iso[5]) {
		let h = +iso[5];
		const mins = iso[6] || "00";
		const ap = (iso[7] || "pm").toLowerCase();
		if (ap === "pm" && h < 12) h += 12;
		if (ap === "am" && h === 12) h = 0;
		time = `${String(h).padStart(2, "0")}:${mins}`;
	}
	return { date, time, starts_at: localToUtc(`${date} ${time}:00`), raw_date_text: `${date} ${time}` };
}

/** Fallback for odd slugs like /event/2026-zz-top-at-8-pm or acltaping-... */
function parseStartsFromDateText(dateText, path) {
	// "July 11, 2026" or "Aug 22-23, 2026" or "Sep 5- 6, 2026"
	// Handles "July 11, 2026", "Aug 22 - 23 , 2026", "Sep 5- 6, 2026", "Oct 16-18, 2026"
	const m = dateText.match(
		/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:\s*-\s*\d{1,2})?\s*,?\s*(\d{4})/i,
	);
	const timeFromPath = path.match(/-at-(\d{1,2})(?:-(\d{2}))?-?(am|pm)/i);
	let time = "20:00";
	if (timeFromPath) {
		let h = +timeFromPath[1];
		const mins = timeFromPath[2] || "00";
		const ap = (timeFromPath[3] || "pm").toLowerCase();
		if (ap === "pm" && h < 12) h += 12;
		if (ap === "am" && h === 12) h = 0;
		time = `${String(h).padStart(2, "0")}:${mins}`;
	}
	if (m) {
		const months = {
			jan: 1,
			january: 1,
			feb: 2,
			february: 2,
			mar: 3,
			march: 3,
			apr: 4,
			april: 4,
			may: 5,
			jun: 6,
			june: 6,
			jul: 7,
			july: 7,
			aug: 8,
			august: 8,
			sep: 9,
			sept: 9,
			september: 9,
			oct: 10,
			october: 10,
			nov: 11,
			november: 11,
			dec: 12,
			december: 12,
		};
		const mo = months[m[1].toLowerCase()];
		const day = String(+m[2]).padStart(2, "0");
		const year = m[3];
		const date = `${year}-${String(mo).padStart(2, "0")}-${day}`;
		return { date, time, starts_at: localToUtc(`${date} ${time}:00`), raw_date_text: `${date} ${time}` };
	}
	// taping: acltaping-sienna-spiro-071526 → MMDDYY
	const tap = path.match(/acltaping-[a-z0-9-]+-(\d{2})(\d{2})(\d{2})$/i);
	if (tap) {
		const mm = tap[1];
		const dd = tap[2];
		const yy = tap[3];
		const year = +yy >= 70 ? `19${yy}` : `20${yy}`;
		const date = `${year}-${mm}-${dd}`;
		return { date, time: "19:00", starts_at: localToUtc(`${date} 19:00:00`), raw_date_text: `${date} 19:00` };
	}
	return null;
}

/** Prefer real purchase URLs (AXS/TM) over the venue event page. */
function extractTicketUrl(html, fallback) {
	const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) =>
		m[1].replace(/&amp;/g, "&"),
	);
	const prefer = hrefs.filter((h) =>
		/axs\.com\/events\/\d+|ticketmaster\.com\/event\/|ticketmaster\.com\/.*\/event|livenation\.com\/.*tickets/i.test(
			h,
		),
	);
	const ticketClass = [
		...html.matchAll(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*tickets[^"]*"/gi),
		...html.matchAll(/class="[^"]*tickets[^"]*"[^>]*href="(https?:\/\/[^"]+)"/gi),
	].map((m) => m[1].replace(/&amp;/g, "&"));
	let url =
		prefer.find((h) => /axs\.com\/events\/\d+/i.test(h)) ||
		ticketClass.find((h) => /^https?:\/\//i.test(h) && !/data\.link/i.test(h)) ||
		prefer[0] ||
		null;
	if (!url) return fallback;
	// Drop analytics junk; keep skin= for 3TEN/Moody AXS skins
	url = url.split(/[?&]_gl=/)[0].replace(/[?&]$/, "");
	return url;
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
		// Try schema / time on detail if needed
		const startMeta =
			html.match(/itemprop="startDate"[^>]*content="([^"]+)"/i)?.[1] ||
			html.match(/"startDate"\s*:\s*"([^"]+)"/i)?.[1] ||
			null;
		const ticket_url = extractTicketUrl(html, url);
		return { description, image_url, startMeta, ticket_url, source_url: url };
	} catch (e) {
		return {
			description: null,
			image_url: null,
			startMeta: null,
			ticket_url: url,
			source_url: url,
			error: e.message,
		};
	}
}

async function scrapeAllEvents() {
	console.log("Paginating /events/events_ajax (infinite scroll)…");
	const byPath = new Map();
	let offset = 0;
	for (let page = 0; page < 50; page++) {
		const html = await ajaxListPage(offset, 0);
		if (!html || html.length < 50) {
			console.log(`  offset ${offset}: empty — done`);
			break;
		}
		const items = parseListItems(html);
		let added = 0;
		for (const it of items) {
			if (byPath.has(it.path)) continue;
			byPath.set(it.path, it);
			added++;
		}
		console.log(`  offset ${offset}: ${items.length} cards, +${added} (total ${byPath.size})`);
		if (items.length === 0) break;
		offset += INCREMENT;
		await new Promise((r) => setTimeout(r, 80));
	}

	const list = [...byPath.values()];
	console.log(`\nList total: ${list.length}`);
	const locCounts = {};
	for (const it of list) locCounts[it.location || "?"] = (locCounts[it.location || "?"] || 0) + 1;
	console.log("By location:", locCounts);

	console.log(`\nEnriching ${list.length} detail pages…`);
	const events = [];
	let i = 0;
	for (const it of list) {
		i++;
		const venueCfg = VENUE_MAP[it.location];
		if (!venueCfg) {
			console.log(`  skip [${it.location}] ${it.title}`);
			continue;
		}

		let parsed = parseStartsFromPath(it.path) || parseStartsFromDateText(it.dateText, it.path);
		const detail = await enrichDetail(it.path);
		if (!parsed && detail.startMeta) {
			const t = +new Date(detail.startMeta);
			if (!Number.isNaN(t)) {
				parsed = {
					starts_at: new Date(t).toISOString(),
					raw_date_text: detail.startMeta,
					date: detail.startMeta.slice(0, 10),
					time: "20:00",
				};
			}
		}
		if (!parsed) {
			console.log(`  NO DATE ${it.path} "${it.dateText}"`);
			continue;
		}
		// Nothing More slug is 2026-01-24 but listing shows Jan 24, 2027 (rescheduled)
		if (it.dateText && /2027|2026/.test(it.dateText)) {
			const fromText = parseStartsFromDateText(it.dateText, it.path);
			if (fromText && fromText.date !== parsed.date) {
				// Prefer visible listing date for reschedules when years disagree
				if (fromText.date.slice(0, 4) !== parsed.date.slice(0, 4)) {
					parsed = fromText;
				}
			}
		}

		if (+new Date(parsed.starts_at) < Date.now() - 2 * 864e5) {
			// still keep far-future; only drop long-past
			if (+new Date(parsed.starts_at) < Date.now() - 30 * 864e5) continue;
		}

		const title = it.tagline ? `${it.title}` : it.title;
		events.push({
			venueSlug: venueCfg.slug,
			venueName: venueCfg.name,
			venueMeta: venueCfg,
			title,
			band: it.title,
			tagline: it.tagline || null,
			starts_at: parsed.starts_at,
			raw_date_text: parsed.raw_date_text,
			image_url: detail.image_url || it.img,
			description: detail.description,
			source_url: `https://www.acllive.com${it.path}`,
			source_event_id: it.path,
			ticket_url: detail.ticket_url || `https://www.acllive.com${it.path}`,
			location: it.location,
			confidence: 0.94,
		});

		if (i % 10 === 0 || i === list.length) {
			console.log(`  [${i}/${list.length}] ${it.location.slice(0, 12)} ${it.title.slice(0, 36)}`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}

	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return events;
}

async function ensureVenue(siteId, meta) {
	let { data: venue } = await sb
		.from("venues")
		.select("id, name, slug")
		.eq("site_id", siteId)
		.eq("slug", meta.slug)
		.maybeSingle();
	if (venue) {
		await sb
			.from("venues")
			.update({
				name: meta.name,
				calendar_url: "https://www.acllive.com/events",
				website_url: meta.website_url,
				updated_at: new Date().toISOString(),
			})
			.eq("id", venue.id);
		return venue;
	}
	const { data: created, error } = await sb
		.from("venues")
		.insert({
			site_id: siteId,
			slug: meta.slug,
			name: meta.name,
			website_url: meta.website_url,
			calendar_url: "https://www.acllive.com/events",
			address: meta.address || null,
			status: "published",
		})
		.select("id, name, slug")
		.single();
	if (error) throw new Error(`create ${meta.slug}: ${error.message}`);
	console.log("created venue", meta.slug);
	return created;
}

async function stageVenue(siteId, venueMeta, events) {
	const venue = await ensureVenue(siteId, venueMeta);
	const calendarUrl = "https://www.acllive.com/events";

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

	await sb
		.from("ingested_events")
		.update({ review_status: "rejected", reviewed_at: new Date().toISOString() })
		.eq("venue_id", venue.id)
		.eq("review_status", "pending");

	const { data: run } = await sb
		.from("ingestion_runs")
		.insert({
			site_id: siteId,
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
		const desc =
			e.description ||
			(e.tagline ? `${e.tagline}. ` : "") + hype(band, venueMeta.name, e.starts_at, i);
		const hosted = e.image_url ? await rehost(siteId, venueMeta.slug.slice(0, 20), e.image_url) : null;
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
				tagline: e.tagline,
				confidence: e.confidence ?? 0.94,
				import_method: "events_ajax_infinite_scroll",
				platform: "axs",
				location: e.location,
			},
		});
		if ((i + 1) % 10 === 0) console.log(`  rehost ${venueMeta.slug} ${i + 1}/${events.length}`);
	}

	for (let i = 0; i < rows.length; i += 40) {
		const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
		if (error) throw new Error(`${venueMeta.slug}: ${error.message}`);
	}

	const imgs = rows.filter((r) => r.raw_payload.image_url).length;
	console.log(`\n=== ${venue.name} === staged ${rows.length}  images ${imgs}`);
	for (const e of events.slice(0, 6)) {
		console.log(
			" ",
			new Date(e.starts_at).toLocaleString("en-US", {
				timeZone: TZ,
				month: "short",
				day: "numeric",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
			}),
			e.title.slice(0, 48),
		);
	}
	if (events.length > 6) console.log(`  … +${events.length - 6} more`);
	return rows.length;
}

console.log("=== ACL Live — full /events infinite-scroll pilot ===\n");
const events = await scrapeAllEvents();
const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();

const byVenue = new Map();
for (const e of events) {
	if (!byVenue.has(e.venueSlug)) byVenue.set(e.venueSlug, []);
	byVenue.get(e.venueSlug).push(e);
}

const results = [];
for (const [slug, list] of byVenue) {
	const meta = list[0].venueMeta;
	console.log(`\nStaging ${slug}: ${list.length} shows`);
	results.push([slug, await stageVenue(site.id, meta, list)]);
}

console.log("\n──── Summary ────");
for (const [slug, n] of results) console.log(`  ${String(n).padStart(3)}  ${slug}`);
console.log(`  total staged: ${results.reduce((a, [, n]) => a + n, 0)}`);
console.log("\nAdmin → https://events-platform-admin.ben-745.workers.dev/ingestion");
