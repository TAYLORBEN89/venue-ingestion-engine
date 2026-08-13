/**
 * Friends Bar full calendar walk (Wix Events API).
 *
 * Interactive calendar path the site uses:
 *   /calendar → day cell → event title → Details → /event-details/{slug}
 *   next-month arrow × ~6 months
 *
 * We hit the same backend:
 *   POST /_api/wix-events-web/v2/events/query
 * with instance auth from wix-warmup-data, filtered to startDate >= now,
 * paginated for ~6 months of shows.
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
const CAL = "https://www.friendsbar.com/calendar";
const BASE = "https://www.friendsbar.com";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
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
	return `${openers[i % openers.length]} Downtown Austin live music on East 6th. Showtime around ${time}. Grab a spot early.`;
}
function cleanImage(url) {
	if (!url) return null;
	const m = String(url).match(/https:\/\/static\.wixstatic\.com\/media\/[a-z0-9_~.-]+/i);
	return m ? m[0] : String(url).split("?")[0];
}

// ── 1. Calendar page → instance token ──
console.log("Loading calendar…");
const calRes = await fetch(CAL, {
	headers: { "User-Agent": UA, Accept: "text/html" },
});
if (!calRes.ok) throw new Error(`calendar HTTP ${calRes.status}`);
const calHtml = await calRes.text();
const warmup = JSON.parse(
	calHtml.match(/<script[^>]*id=["']wix-warmup-data["'][^>]*>([\s\S]*?)<\/script>/i)[1],
);
const appKey = Object.keys(warmup.appsWarmupData || {})[0];
const appData = warmup.appsWarmupData[appKey] || {};
const widget = appData["widgetcomp-mbfnlbia"];
const instance =
	widget?.instance?.instance ||
	appData["widgetTPASection_masov7zf"]?.instance?.instance ||
	calHtml.match(/"instance"\s*:\s*"(ha[A-Za-z0-9_.-]{40,})"/)?.[1];
if (!instance) throw new Error("No Wix instance token on calendar page");
console.log("instance ok");

// Warmup dates map for local display times
const widgetDates = widget?.dates?.events || {};
const widgetById = new Map((widget?.events?.events || []).map((e) => [e.id, e]));

// ── 2. Query upcoming events (same backend as grid / Details) ──
const cutoff = new Date(Date.now() - 864e5).toISOString();
const horizonMs = Date.now() + 185 * 864e5; // ~6 months
const byId = new Map();
const limit = 100;
let offset = 0;
let total = Infinity;
let pages = 0;

while (offset < total && pages < 30) {
	const res = await fetch(`${BASE}/_api/wix-events-web/v2/events/query`, {
		method: "POST",
		headers: {
			Authorization: instance,
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": UA,
			Origin: BASE,
			Referer: CAL,
		},
		body: JSON.stringify({
			query: {
				filter: {
					"scheduling.config.startDate": { $gte: cutoff },
				},
				sort: [{ fieldName: "scheduling.config.startDate", order: "ASC" }],
				paging: { limit, offset },
			},
		}),
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(`events query ${res.status}: ${t.slice(0, 250)}`);
	}
	const data = await res.json();
	const batch = data.events || [];
	total = data.pagingMetadata?.total ?? data.total ?? offset + batch.length;
	pages++;

	let beyond = 0;
	for (const e of batch) {
		const startRaw = e.scheduling?.config?.startDate || e.startDate;
		if (!startRaw || !e.title || !e.slug) continue;
		if (+new Date(startRaw) > horizonMs) {
			beyond++;
			continue;
		}
		if (/^\s*(private|closed|tbd)\s*$/i.test(e.title)) continue;
		// Merge warmup image/description if API thin
		const warm = widgetById.get(e.id);
		byId.set(e.id, {
			...e,
			mainImage: e.mainImage || warm?.mainImage,
			description: e.description || warm?.description || "",
			about: e.about || warm?.about || "",
		});
	}
	console.log(
		`page ${pages} offset=${offset} +${batch.length} kept=${byId.size} total=${total} beyondHorizon=${beyond}`,
	);

	offset += batch.length;
	if (!batch.length) break;
	// stop once a full page is past the 6-month horizon
	if (beyond === batch.length && byId.size > 0) break;
}

console.log(`unique events in window: ${byId.size}`);

// ── 3. Normalize ──
const events = [];
for (const e of byId.values()) {
	const dateInfo = widgetDates[e.id];
	const startRaw =
		dateInfo?.startDateISOFormatNotUTC ||
		e.scheduling?.config?.startDate ||
		e.startDate;
	const starts_at = new Date(startRaw).toISOString();
	const title = stripHtml(e.title);
	const slug = e.slug;
	const source_url = `${BASE}/event-details/${slug}`;
	const image_url = cleanImage(e.mainImage?.url || e.image?.url);
	const description = stripHtml(e.description || e.about || "") || null;
	const band = title.split(/[:–|]/)[0].trim();

	events.push({
		title,
		band,
		starts_at,
		image_url,
		source_url,
		source_event_id: e.id || slug,
		raw_date_text: dateInfo?.fullDate || dateInfo?.shortStartDateTime || startRaw,
		ticket_url: source_url,
		description,
		confidence: 0.94,
	});
}
events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

const byMonth = {};
for (const e of events) {
	const m = new Date(e.starts_at).toLocaleString("en-US", {
		timeZone: TZ,
		year: "numeric",
		month: "short",
	});
	byMonth[m] = (byMonth[m] || 0) + 1;
}
console.log("by month", byMonth);
console.log(
	`images ${events.filter((e) => e.image_url).length} descs ${events.filter((e) => e.description).length}`,
);
for (const e of events.slice(0, 10)) {
	console.log(
		" ",
		new Date(e.starts_at).toLocaleString("en-US", {
			timeZone: TZ,
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}),
		e.title.slice(0, 40),
		e.image_url ? "🖼" : "·",
		e.source_url.replace(BASE, ""),
	);
}
if (!events.length) {
	console.error("No events");
	process.exit(1);
}

// ── 4. Stage pending ──
const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id, name")
	.eq("site_id", site.id)
	.eq("slug", "friends-bar")
	.single();

await sb
	.from("venues")
	.update({ calendar_url: CAL, website_url: "https://www.friendsbar.com/" })
	.eq("id", venue.id);

const { data: sources } = await sb.from("venue_event_sources").select("id").eq("venue_id", venue.id).limit(1);
if (sources?.[0]) {
	await sb
		.from("venue_event_sources")
		.update({
			platform_type: "wix_events",
			feed_url: CAL,
			calendar_url: CAL,
			updated_at: new Date().toISOString(),
		})
		.eq("id", sources[0].id);
} else {
	await sb.from("venue_event_sources").insert({
		venue_id: venue.id,
		platform_type: "wix_events",
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

const venueName = "Friends Bar";
const rows = events.map((e, i) => {
	const desc = e.description || hype(e.band, venueName, e.starts_at, i);
	return {
		ingestion_run_id: run.id,
		venue_id: venue.id,
		raw_title: e.title,
		raw_date_text: e.raw_date_text,
		parsed_starts_at: e.starts_at,
		parsed_ends_at: null,
		source_url: e.source_url,
		source_event_id: e.source_event_id,
		fingerprint: fp(e.title, e.starts_at, e.ticket_url),
		source_partner: "wix_events",
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
			image_url: e.image_url,
			confidence: e.confidence,
			import_method: "feed",
			platform: "wix_events",
		},
	};
});

for (let i = 0; i < rows.length; i += 50) {
	const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 50));
	if (error) throw new Error(error.message);
}

console.log(
	`\n=== Friends Bar === staged ${rows.length} images ${rows.filter((r) => r.raw_payload.image_url).length}`,
);
console.log("Done → https://events-platform-admin.ben-745.workers.dev/ingestion");
