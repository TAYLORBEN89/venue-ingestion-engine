/**
 * New venue pilot batch: Germania Amphitheater, Friends Bar, Far Out, Vulcan, Mercer
 * Stages pending with platform-appropriate parsers (local fetch).
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
	const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
	return (asUtc - at.getTime()) / 60000;
}
function localToUtc(local, timeZone = TZ) {
	const [datePart, timePart] = local.replace("T", " ").split(" ");
	const [y, m, d] = datePart.split("-").map(Number);
	const [hh, mm, ss = 0] = timePart.split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, Number(ss)));
	return new Date(guess.getTime() - getOffsetMin(timeZone, guess) * 60000).toISOString();
}
function stripHtml(v) {
	return String(v || "")
		.replace(/&amp;/gi, "&")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
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
async function get(url) {
	const r = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 events-platform-pilot", Accept: "*/*" },
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

function buildScootStyleDesc(band, venueName, startsAt, i) {
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
		`Catch ${band} live at ${venueName} on ${date}.`,
		`${band} hits the stage at ${venueName} on ${date}.`,
		`Don't miss ${band} at ${venueName} — ${date}.`,
		`${band} brings the heat to ${venueName} on ${date}.`,
		`See ${band} under the lights at ${venueName} on ${date}.`,
	];
	return `${openers[i % openers.length]} Austin live music energy and a night worth showing up early for. Showtime around ${time}. Grab tickets and get there early.`;
}

async function stage(slug, platform, calendarUrl, websiteUrl, events, venueName) {
	const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
	let { data: venue } = await sb
		.from("venues")
		.select("id, name, address")
		.eq("site_id", site.id)
		.eq("slug", slug)
		.maybeSingle();
	if (!venue) {
		console.log(`SKIP missing venue ${slug}`);
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

	const rows = events.map((e, i) => {
		const desc =
			e.description ||
			buildScootStyleDesc(e.title.split(/[:–-]/)[0].trim() || e.title, venueName || venue.name, e.starts_at, i);
		return {
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
			extracted_band_name: (e.title.split(/[:–-]/)[0] || e.title).trim(),
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
		if (error) throw new Error(`${slug}: ${error.message}`);
	}

	const withImg = rows.filter((r) => r.raw_payload.image_url).length;
	console.log(`\n=== ${venue.name} (${slug}) ===`);
	console.log(`staged ${rows.length} | images ${withImg}`);
	for (const e of events.slice(0, 4)) {
		const local = new Date(e.starts_at).toLocaleString("en-US", {
			timeZone: TZ,
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
		console.log(`  ${local} | ${e.title.slice(0, 50)} | img=${!!e.image_url}`);
	}
	return rows.length;
}

// ---- 1) Germania Amphitheater via Ticketmaster venue page JSON-LD / embedded ----
{
	const url = "https://www.ticketmaster.com/germania-insurance-amphitheater-tickets-austin/venue/476047";
	const html = await get(url);
	const events = [];
	// Parse ld+json blocks
	for (const b of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			const raw = JSON.parse(b[1]);
			const items = Array.isArray(raw) ? raw : raw["@graph"] ? raw["@graph"] : [raw];
			for (const item of items) {
				if (item["@type"] !== "MusicEvent" && item["@type"] !== "Event") continue;
				const name = (item.name || "").trim();
				if (!name || /parking|not a concert|vip package|meet\s*&\s*greet only/i.test(name)) continue;
				if (!item.startDate) continue;
				const m = String(item.startDate).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
				const starts_at = m
					? localToUtc(`${m[1]} ${m[2]}:${m[3] || "00"}`, TZ)
					: new Date(item.startDate).toISOString();
				if (new Date(starts_at) < Date.now() - 864e5) continue;
				const img = typeof item.image === "string" ? item.image : Array.isArray(item.image) ? item.image[0] : null;
				const offers = item.offers;
				const ticket = (Array.isArray(offers) ? offers[0]?.url : offers?.url) || item.url || url;
				events.push({
					title: name,
					starts_at,
					description: item.description ? stripHtml(item.description) : null,
					image_url: img,
					source_url: ticket,
					source_event_id: ticket?.match(/event\/([A-Za-z0-9]+)/i)?.[1] || `${name}|${starts_at}`,
					raw_date_text: item.startDate,
					ticket_url: ticket,
					confidence: 0.93,
				});
			}
		} catch {}
	}
	// Fallback: parse event cards from HTML if ld+json sparse
	if (events.length < 5) {
		// Ticketmaster often embeds __NEXT_DATA__ or similar
		const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
		if (next) {
			try {
				const j = JSON.parse(next[1]);
				const str = JSON.stringify(j);
				// crude extract of event objects with name+date+url
				const re =
					/"name":"([^"\\]{3,80})"[^]{0,400}?"url":"(https:\\\/\\\/www\.ticketmaster\.com\\\/[^"]+)"[^]{0,400}?"date":"([^"]+)"/g;
				// simpler walk
				function walk(o, depth = 0) {
					if (!o || depth > 12) return;
					if (Array.isArray(o)) {
						for (const x of o) walk(x, depth + 1);
						return;
					}
					if (typeof o === "object") {
						if (o.name && (o.dates?.start?.dateTime || o.date) && (o.url || o.id)) {
							const title = String(o.name);
							if (/parking|not a concert/i.test(title)) return;
							const rawDate = o.dates?.start?.dateTime || o.date;
							const starts_at = new Date(rawDate).toISOString();
							if (isNaN(+new Date(starts_at)) || +new Date(starts_at) < Date.now() - 864e5) return;
							const ticket = (o.url || "").replace(/\\\//g, "/");
							const img =
								o.images?.find((im) => im.ratio === "16_9")?.url ||
								o.images?.[0]?.url ||
								null;
							events.push({
								title,
								starts_at,
								description: null,
								image_url: img,
								source_url: ticket || url,
								source_event_id: o.id || `${title}|${starts_at}`,
								raw_date_text: rawDate,
								ticket_url: ticket || url,
								confidence: 0.9,
							});
						}
						for (const v of Object.values(o)) walk(v, depth + 1);
					}
				}
				walk(j);
			} catch {}
		}
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
	await stage(
		"germania-insurance-amphitheater",
		"livenation",
		"https://www.germaniaamp.com/events",
		"https://www.germaniaamp.com/",
		uniq,
		"Germania Insurance Amphitheater",
	);
}

// ---- 2) Friends Bar — Wix Events calendar ----
{
	const html = await get("https://www.friendsbar.com/calendar");
	const events = [];
	// Pattern: event-details/slug-YYYY-MM-DD...">Title</a> ... short-date">Fri, Jul 10
	// Also time often nearby
	const blocks = [
		...html.matchAll(
			/event-details\/([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})[^"]*"[^>]*>([^<]{2,80})<\/a>[\s\S]{0,400}?data-hook="short-date"[^>]*>([^<]+)</gi,
		),
	];
	// Alternate: href with event-details then title
	if (blocks.length < 3) {
		const alts = [
			...html.matchAll(
				/href="[^"]*event-details\/([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})[^"]*"[^>]*rel="">([^<]{2,80})<\/a>[\s\S]{0,500}?short-date[^>]*>([^<]{3,40})</gi,
			),
		];
		for (const m of alts) blocks.push(m);
	}
	const seen = new Set();
	for (const m of blocks) {
		const slug = m[1];
		const date = m[2];
		const title = stripHtml(m[3]);
		const shortDate = stripHtml(m[4]);
		if (!title || /menus|order|experience/i.test(title)) continue;
		const key = `${title}|${date}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// default evening showtime if unknown
		let hour = 19,
			minute = 0;
		const tm = shortDate.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
		if (tm) {
			hour = +tm[1];
			minute = +tm[2];
			const ap = tm[3].toUpperCase();
			if (ap === "PM" && hour < 12) hour += 12;
			if (ap === "AM" && hour === 12) hour = 0;
		}
		const wall = `${date} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
		const starts_at = localToUtc(wall, TZ);
		if (+new Date(starts_at) < Date.now() - 864e5) continue;
		// image near block
		const around = html.slice(Math.max(0, m.index - 200), m.index + 800);
		const img =
			around.match(/src="(https:\/\/static\.wixstatic\.com\/[^"]+)"/i)?.[1] ||
			around.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i)?.[1] ||
			null;
		const eventUrl = `https://www.friendsbar.com/event-details/${slug}-${date}-12-00`;
		events.push({
			title,
			starts_at,
			description: null,
			image_url: img,
			source_url: eventUrl,
			source_event_id: `${slug}-${date}`,
			raw_date_text: `${shortDate} ${date}`,
			ticket_url: eventUrl,
			confidence: 0.85,
		});
	}
	// Broader fallback: all event-details links
	if (events.length < 3) {
		const links = [
			...html.matchAll(/href="([^"]*event-details\/([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})[^"]*)"[^>]*>([^<]{2,80})</gi),
		];
		const seen2 = new Set();
		for (const m of links) {
			const title = stripHtml(m[4]);
			const date = m[3];
			const key = `${title}|${date}`;
			if (seen2.has(key) || !title) continue;
			seen2.add(key);
			const wall = `${date} 19:00:00`;
			const starts_at = localToUtc(wall, TZ);
			if (+new Date(starts_at) < Date.now() - 864e5) continue;
			events.push({
				title,
				starts_at,
				source_url: m[1].startsWith("http") ? m[1] : `https://www.friendsbar.com${m[1]}`,
				source_event_id: `${m[2]}-${date}`,
				raw_date_text: date,
				ticket_url: m[1].startsWith("http") ? m[1] : `https://www.friendsbar.com${m[1]}`,
				confidence: 0.8,
			});
		}
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	await stage("friends-bar", "wix_events", "https://www.friendsbar.com/calendar", "https://www.friendsbar.com/", events, "Friends Bar");
}

// ---- 3) Mercer Dancehall — scrape MEC event list HTML ----
{
	const html = await get("https://mercerdancehall.com/events");
	const events = [];
	// MEC list items
	const items = [
		...html.matchAll(
			/<article[^>]*class="[^"]*mec-event[^"]*"[^>]*>([\s\S]*?)<\/article>/gi,
		),
	];
	// alt: mec-event-title links
	const titles = [
		...html.matchAll(
			/href="(https?:\/\/mercerdancehall\.com\/events\/[^"]+)"[^>]*>([^<]{3,80})</gi,
		),
	];
	const seen = new Set();
	for (const m of titles) {
		const url = m[1];
		const title = stripHtml(m[2]);
		if (!title || /no events|events for/i.test(title)) continue;
		if (seen.has(url)) continue;
		seen.add(url);
		// fetch detail for date
		try {
			const detail = await get(url);
			const startAbs =
				detail.match(/itemprop="startDate"\s+content="([^"]+)"/i)?.[1] ||
				detail.match(/datetime="(\d{4}-\d{2}-\d{2}T[^"]+)"/i)?.[1];
			let starts_at = null;
			if (startAbs) {
				starts_at = new Date(startAbs).toISOString();
			} else {
				const d = detail.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})/);
				if (d) starts_at = localToUtc(`${d[1]}-${d[2]}-${d[3]} 20:00:00`, TZ);
			}
			if (!starts_at || +new Date(starts_at) < Date.now() - 864e5) continue;
			const img =
				detail.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ||
				detail.match(/class="[^"]*mec-events-event-image[^"]*"[\s\S]{0,200}?src="([^"]+)"/i)?.[1] ||
				null;
			const desc =
				stripHtml(
					detail.match(/class="[^"]*mec-single-event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
						detail.match(/property="og:description"\s+content="([^"]+)"/i)?.[1] ||
						"",
				) || null;
			events.push({
				title,
				starts_at,
				description: desc && desc.length > 20 ? desc : null,
				image_url: img,
				source_url: url,
				source_event_id: url,
				raw_date_text: startAbs || starts_at,
				ticket_url: url,
				confidence: 0.88,
			});
		} catch {
			/* skip */
		}
	}
	events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	await stage(
		"mercer-dancehall",
		"mec",
		"https://mercerdancehall.com/events",
		"https://www.mercerdancehall.com/",
		events,
		"Mercer Dancehall",
	);
}

// ---- 4) ACL Live — try ticketmaster / venue site ----
{
	const urls = ["https://www.ticketmaster.com/acl-live-at-the-moody-theater-tickets-austin/venue/475865", "https://www.acllive.com/"];
	const events = [];
	for (const url of urls) {
		try {
			const html = await get(url);
			for (const b of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
				try {
					const raw = JSON.parse(b[1]);
					const items = Array.isArray(raw) ? raw : raw["@graph"] ? raw["@graph"] : [raw];
					for (const item of items) {
						if (item["@type"] !== "MusicEvent" && item["@type"] !== "Event") continue;
						const name = (item.name || "").trim();
						if (!name || /parking|not a concert/i.test(name)) continue;
						if (!item.startDate) continue;
						const m = String(item.startDate).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
						const starts_at = m
							? localToUtc(`${m[1]} ${m[2]}:${m[3] || "00"}`, TZ)
							: new Date(item.startDate).toISOString();
						if (+new Date(starts_at) < Date.now() - 864e5) continue;
						const img =
							typeof item.image === "string" ? item.image : Array.isArray(item.image) ? item.image[0] : null;
						const ticket = item.offers?.url || item.url || url;
						events.push({
							title: name,
							starts_at,
							description: item.description ? stripHtml(item.description) : null,
							image_url: img,
							source_url: ticket,
							source_event_id: ticket?.match(/event\/([A-Za-z0-9]+)/i)?.[1] || `${name}|${starts_at}`,
							raw_date_text: item.startDate,
							ticket_url: ticket,
							confidence: 0.92,
						});
					}
				} catch {}
			}
			// NEXT_DATA walk for TM
			const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
			if (next && events.length < 5) {
				try {
					const j = JSON.parse(next[1]);
					function walk(o, depth = 0) {
						if (!o || depth > 14) return;
						if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
						if (typeof o === "object") {
							if (o.name && o.dates?.start?.dateTime) {
								const title = String(o.name);
								if (/parking|not a concert/i.test(title)) return;
								const starts_at = new Date(o.dates.start.dateTime).toISOString();
								if (+new Date(starts_at) < Date.now() - 864e5) return;
								const ticket = (o.url || "").replace(/\\\//g, "/");
								const img = o.images?.find((im) => im.ratio === "16_9")?.url || o.images?.[0]?.url;
								events.push({
									title,
									starts_at,
									image_url: img,
									source_url: ticket || url,
									source_event_id: o.id || `${title}|${starts_at}`,
									raw_date_text: o.dates.start.dateTime,
									ticket_url: ticket || url,
									confidence: 0.9,
								});
							}
							for (const v of Object.values(o)) walk(v, depth + 1);
						}
					}
					walk(j);
				} catch {}
			}
		} catch (e) {
			console.log("acl probe", e.message);
		}
	}
	const seen = new Set();
	const uniq = [];
	for (const e of events) {
		if (seen.has(e.source_event_id)) continue;
		seen.add(e.source_event_id);
		uniq.push(e);
	}
	uniq.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	await stage("acl-live", "livenation", "https://www.acllive.com/", "https://www.acllive.com/", uniq, "ACL Live");
}

console.log("\nDone. Review: https://events-platform-admin.ben-745.workers.dev/ingestion");
