/**
 * The Carousel Lounge pilot — TEC multi-month calendar.
 *
 * Calendar (elementor embed):
 *   https://carousellounge.com/elementor-1022/
 * Month grid: table.tribe-events-calendar-month
 * Next month: title="Next month, …" / caret-right SVG
 *   → https://carousellounge.com/calendar/month/YYYY-MM/?shortcode=ecb53827
 *
 * Primary ingest: Tribe REST (paginated) — same events as month chevrons.
 * Configures venue_event_sources for ongoing TEC scrapes with 180+ days ahead.
 *
 * From apps/ingestion:
 *   node scripts/pilot-carousel-lounge.mjs
 *   node scripts/pilot-carousel-lounge.mjs --dry
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const DRY = process.argv.includes("--dry");
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
const VENUE_SLUG = "the-carousel-lounge";
const CALENDAR_URL = "https://carousellounge.com/elementor-1022/";
const FEED_URL =
	"https://carousellounge.com/wp-json/tribe/events/v1/events";
const SITE_ID = "51177cff-babf-4a36-a258-834f4e880b87";
const SCRAPE_DAYS = 180; // ~6 months — matches caret navigation through year
const MAX_EVENTS = 400;

function decodeEntities(v) {
	return String(v || "")
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&amp;/gi, "&")
		.replace(/&#038;/g, "&")
		.replace(/&#8211;|&#8212;/g, "–")
		.replace(/&#8216;|&#8217;|&#039;|&apos;/g, "'")
		.replace(/&#8220;|&#8221;|&quot;/g, '"')
		.replace(/&nbsp;/gi, " ");
}

function stripHtml(v) {
	return decodeEntities(v)
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
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
		(Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second) -
			at.getTime()) /
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

function fp(title, starts, sourceId) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${sourceId ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}

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
	return `${slugify(title)}-${parts.year}-${parts.month}-${parts.day}-${hour}${parts.minute ?? "00"}`;
}

function isClosedTitle(title) {
	const t = String(title || "");
	return (
		/^closed\b/i.test(t) ||
		/\bclosed\b/i.test(t) ||
		/\b(thanksgiving|christmas)\b.*\bclosed\b/i.test(t) ||
		/\bclosed\b.*\b(christmas|thanksgiving|july 4|4th of july)/i.test(t)
	);
}

async function fetchAllTribeEvents() {
	const start = new Date();
	const end = new Date(Date.now() + SCRAPE_DAYS * 24 * 60 * 60 * 1000);
	const startDate = start.toISOString().slice(0, 10);
	const endDate = end.toISOString().slice(0, 10);

	const all = [];
	let page = 1;
	let totalPages = 1;

	while (page <= totalPages && page <= 20 && all.length < MAX_EVENTS) {
		const url = new URL(FEED_URL);
		url.searchParams.set("per_page", "50");
		url.searchParams.set("page", String(page));
		url.searchParams.set("start_date", startDate);
		url.searchParams.set("end_date", endDate);
		url.searchParams.set("status", "publish");

		const r = await fetch(url.toString(), {
			headers: {
				Accept: "application/json",
				"User-Agent": "Mozilla/5.0 events-platform-carousel-pilot",
			},
		});
		if (!r.ok) throw new Error(`Tribe API HTTP ${r.status} page ${page}`);
		const j = await r.json();
		const batch = j.events || [];
		totalPages = j.total_pages || totalPages;
		console.log(
			`  API page ${page}/${totalPages}: ${batch.length} events (total~${j.total ?? "?"})`,
		);
		if (!batch.length) break;
		all.push(...batch);
		if (page >= totalPages || batch.length < 50) break;
		page++;
	}

	const byId = new Map();
	for (const e of all) byId.set(e.id, e);
	return [...byId.values()].sort((a, b) =>
		String(a.start_date).localeCompare(String(b.start_date)),
	);
}

async function rehost(siteId, imageUrl, alt) {
	if (!imageUrl || DRY) return null;
	try {
		const res = await fetch(imageUrl, {
			headers: { Accept: "image/*,*/*", "User-Agent": "Mozilla/5.0" },
			redirect: "follow",
			signal: AbortSignal.timeout(25000),
		});
		if (!res.ok) return null;
		const contentType = res.headers.get("content-type") || "image/jpeg";
		const bytes = Buffer.from(await res.arrayBuffer());
		const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
		const ext = contentType.includes("png") ? "png" : "jpg";
		const storagePath = `${siteId}/events/carousel/${hash}.${ext}`;
		const { error: upErr } = await sb.storage.from("event-media").upload(storagePath, bytes, {
			contentType: contentType.startsWith("image/") ? contentType : "image/jpeg",
			upsert: true,
		});
		if (upErr) return null;
		const {
			data: { publicUrl },
		} = sb.storage.from("event-media").getPublicUrl(storagePath);
		const { data: media } = await sb
			.from("media")
			.insert({
				site_id: siteId,
				storage_path: publicUrl,
				alt_text: alt,
			})
			.select("id")
			.single();
		return media?.id ?? null;
	} catch {
		return null;
	}
}

async function insertEvent(row) {
	for (let attempt = 0; attempt < 6; attempt++) {
		const trySlug = attempt === 0 ? row.slug : `${row.slug}-c${attempt + 1}`;
		const { data, error } = await sb
			.from("events")
			.insert({ ...row, slug: trySlug })
			.select("id")
			.single();
		if (!error && data) return data;
		if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
	}
	throw new Error("slug fail " + row.title);
}

async function main() {
	console.log(DRY ? "DRY" : "APPLY", "Carousel Lounge multi-month TEC pilot");
	console.log("calendar", CALENDAR_URL);
	console.log("window", SCRAPE_DAYS, "days ahead via Tribe REST pagination");

	const { data: venue, error: vErr } = await sb
		.from("venues")
		.select("id, name, slug, site_id, featured_media_id, address")
		.eq("slug", VENUE_SLUG)
		.single();
	if (vErr || !venue) throw new Error("venue missing: " + vErr?.message);
	console.log("venue", venue.name, venue.id);

	// ── Configure source for pilot + nightly TEC ──
	const sourcePatch = {
		calendar_url: CALENDAR_URL,
		feed_url: FEED_URL,
		platform_type: "tec",
		scrape_days_ahead: SCRAPE_DAYS,
		publish_mode: "auto_publish",
		is_enabled: true,
		timezone: TZ,
		updated_at: new Date().toISOString(),
	};

	if (!DRY) {
		const { data: sources } = await sb
			.from("venue_event_sources")
			.select("id")
			.eq("venue_id", venue.id)
			.limit(1);
		if (sources?.[0]) {
			const { error } = await sb
				.from("venue_event_sources")
				.update(sourcePatch)
				.eq("id", sources[0].id);
			if (error) {
				// platform_type enum may not include tec
				console.warn("source update with tec failed:", error.message);
				await sb
					.from("venue_event_sources")
					.update({ ...sourcePatch, platform_type: "auto" })
					.eq("id", sources[0].id);
			}
			console.log("updated venue_event_sources", sources[0].id);
		} else {
			await sb.from("venue_event_sources").insert({
				venue_id: venue.id,
				...sourcePatch,
			});
			console.log("inserted venue_event_sources");
		}
	} else {
		console.log("[dry] would set source", sourcePatch);
	}

	// Reject junk pending if any
	if (!DRY) {
		const { data: pending } = await sb
			.from("ingested_events")
			.select("id, raw_title")
			.eq("venue_id", venue.id)
			.eq("review_status", "pending");
		for (const p of pending || []) {
			await sb
				.from("ingested_events")
				.update({ review_status: "rejected", reviewed_at: new Date().toISOString() })
				.eq("id", p.id);
			console.log("rejected pending", p.raw_title?.slice(0, 50));
		}
	}

	console.log("\nFetching Tribe events (multi-page = multi-month)…");
	const tribe = await fetchAllTribeEvents();
	try {
		writeFileSync("../../tmp-carousel-events-full.json", JSON.stringify(tribe, null, 2));
	} catch {
		/* optional dump */
	}
	console.log("fetched", tribe.length);

	const months = {};
	for (const e of tribe) {
		const m = String(e.start_date).slice(0, 7);
		months[m] = (months[m] || 0) + 1;
	}
	console.log("by month", months);

	const { data: cats } = await sb
		.from("categories")
		.select("id, slug")
		.eq("site_id", venue.site_id || SITE_ID);
	const liveMusic = (cats || []).find((c) => c.slug === "live-music")?.id;

	const todayYmd = new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());

	let created = 0;
	let updated = 0;
	let skipped = 0;
	let closed = 0;

	for (const row of tribe) {
		const title = stripHtml(row.title);
		if (isClosedTitle(title)) {
			closed++;
			continue;
		}

		const startsAt = localToUtc(row.start_date);
		const endsAt = row.end_date ? localToUtc(row.end_date) : null;
		const startYmd = new Intl.DateTimeFormat("en-CA", {
			timeZone: TZ,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date(startsAt));
		if (startYmd < todayYmd) {
			skipped++;
			continue;
		}

		const description = stripHtml(row.description || row.excerpt || "") || null;
		const imageUrl =
			row.image && typeof row.image === "object" ? row.image.url || null : null;
		const cost = stripHtml((row.cost || "").trim());
		const priceText = cost
			? /free|^0$/i.test(cost)
				? "Free"
				: cost.startsWith("$")
					? cost
					: `$${cost}`
			: null;

		const event_intro = description
			? description.slice(0, 280).replace(/\s+/g, " ").trim()
			: `${title} live at The Carousel Lounge.`;

		console.log("+", startYmd, title.slice(0, 55));

		if (DRY) {
			created++;
			continue;
		}

		const mediaId =
			(await rehost(venue.site_id || SITE_ID, imageUrl, title)) ||
			venue.featured_media_id ||
			null;

		const eventRow = {
			site_id: venue.site_id || SITE_ID,
			venue_id: venue.id,
			title,
			description,
			event_intro,
			starts_at: startsAt,
			ends_at: endsAt,
			ticket_url: row.url || null,
			price_text: priceText,
			featured_media_id: mediaId,
			status: "published",
			source: "partner_import",
			slug: eventSlug(title, startsAt),
			seo_title: `${title} | The Carousel Lounge`.slice(0, 60),
			seo_description: (event_intro || title).slice(0, 155),
			focus_keyphrase: title.slice(0, 60),
			schema_type: "MusicEvent",
			field_sources: {
				title: "venue",
				description: "venue",
				starts_at: "venue",
				image: imageUrl ? "venue" : "venue",
				source_url: row.url,
				tribe_id: String(row.id),
			},
		};

		// Match existing by tribe id in field_sources or title+start
		const { data: existing } = await sb
			.from("events")
			.select("id, field_sources")
			.eq("venue_id", venue.id)
			.eq("starts_at", startsAt)
			.is("deleted_at", null)
			.limit(5);

		const match =
			(existing || []).find(
				(e) =>
					e.field_sources?.tribe_id === String(row.id) ||
					String(e.field_sources?.source_url || "").includes(row.slug || "___"),
			) ||
			(existing || []).find(() => true); // same start — check title fuzzy

		let existingId = null;
		if (existing?.length) {
			const { data: byTitle } = await sb
				.from("events")
				.select("id")
				.eq("venue_id", venue.id)
				.eq("starts_at", startsAt)
				.eq("title", title)
				.is("deleted_at", null)
				.maybeSingle();
			existingId = byTitle?.id || null;
		}

		if (existingId) {
			await sb
				.from("events")
				.update({
					title,
					description,
					event_intro,
					ends_at: endsAt,
					price_text: priceText,
					featured_media_id: mediaId || undefined,
					ticket_url: row.url,
					status: "published",
					field_sources: eventRow.field_sources,
					updated_at: new Date().toISOString(),
				})
				.eq("id", existingId);
			if (liveMusic) {
				await sb.from("event_categories").upsert(
					{ event_id: existingId, category_id: liveMusic },
					{ onConflict: "event_id,category_id" },
				);
			}
			updated++;
		} else {
			const ins = await insertEvent(eventRow);
			if (liveMusic) {
				await sb.from("event_categories").upsert(
					{ event_id: ins.id, category_id: liveMusic },
					{ onConflict: "event_id,category_id" },
				);
			}
			created++;
		}
	}

	console.log("\n=== SUMMARY ===");
	console.log({
		fetched: tribe.length,
		months,
		created,
		updated,
		skippedPast: skipped,
		skippedClosed: closed,
		scrape_days_ahead: SCRAPE_DAYS,
		calendar_url: CALENDAR_URL,
	});
	if (DRY) console.log("Re-run without --dry to write.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
