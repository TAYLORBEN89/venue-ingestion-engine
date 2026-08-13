/**
 * The Mohawk (Austin) pilot — Prekindle widget walkthrough
 *
 * List:  https://mohawkaustin.com/  → #list-view .list-view-item (JS widget)
 * Detail: https://mohawkaustin.com/event/?id={id}
 *   .event-image background cloudfront, .event-headline, .event-support,
 *   .event-date, .event-get-tickets-button → etix, .event-description
 * More:  #more-view reloadWidget (same Prekindle organizer API returns full list)
 *
 * Data source: Prekindle organizer API (same feed the widget uses).
 *
 *   node scripts/pilot-mohawk.mjs
 *   node scripts/pilot-mohawk.mjs --probe-only
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeOnly = process.argv.includes("--probe-only");
const VENUE_SLUG = "the-mohawk";
const CAL = "https://mohawkaustin.com/";
const ORG_ID = "531433527670566235";
const TZ = "America/Chicago";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const env = Object.fromEntries(
	readFileSync(resolve(__dirname, "../.dev.vars"), "utf8")
		.split(/\r?\n/)
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function fp(title, starts, ticket) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${ticket ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}

function getOffsetMin(at) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: TZ,
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

function parseLocalIso(date, time) {
	const [month, day, year] = date.split("/").map(Number);
	const m = time.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!m) throw new Error(`bad time ${time}`);
	let hour = Number(m[1]) % 12;
	if (m[3].toLowerCase() === "pm") hour += 12;
	const local = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${m[2]}:00`;
	const [datePart, timePart] = local.split(" ");
	const [y, mo, d] = datePart.split("-").map(Number);
	const [hh, mm, ss = 0] = timePart.split(":").map(Number);
	const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm, +ss));
	return new Date(guess.getTime() - getOffsetMin(guess) * 60000).toISOString();
}

function stripHtml(text) {
	if (!text) return null;
	const plain = String(text)
		.replace(/&nbsp;/gi, " ")
		.replace(/&rsquo;|&#8217;/gi, "'")
		.replace(/&ldquo;|&rdquo;/gi, '"')
		.replace(/&amp;/gi, "&")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length ? plain.slice(0, 4000) : null;
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
		const path = `${siteId}/mohawk/${randomUUID()}.${ext}`;
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

console.log("\n=== The Mohawk pilot (Prekindle widget / list-view) ===\n");

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, slug, name, calendar_url, website_url, address")
	.eq("slug", VENUE_SLUG)
	.maybeSingle();
if (vErr || !venue) throw new Error(`Venue not found: ${VENUE_SLUG}`);
console.log("Venue:", venue.name, venue.id);

await sb
	.from("venues")
	.update({
		calendar_url: CAL,
		website_url: "https://mohawkaustin.com/",
		updated_at: new Date().toISOString(),
	})
	.eq("id", venue.id);

const { data: sources } = await sb
	.from("venue_event_sources")
	.select("id")
	.eq("venue_id", venue.id);
const sourcePayload = {
	platform_type: "prekindle",
	calendar_url: CAL,
	feed_url: `https://www.prekindle.com/api/events/organizer/${ORG_ID}`,
	is_enabled: true,
	scrape_days_ahead: 180,
	publish_mode: "draft",
	timezone: TZ,
	last_scrape_error: null,
	updated_at: new Date().toISOString(),
};
if (sources?.[0]) {
	await sb.from("venue_event_sources").update(sourcePayload).eq("id", sources[0].id);
	console.log("Updated source", sources[0].id, "→ prekindle / enabled / 180d");
} else {
	const { data: ins, error } = await sb
		.from("venue_event_sources")
		.insert({ venue_id: venue.id, ...sourcePayload })
		.select("id")
		.single();
	if (error) throw new Error(error.message);
	console.log("Created source", ins.id);
}

// Fetch organizer API (same data as #list-view + more-view)
const apiUrl = `https://www.prekindle.com/api/events/organizer/${ORG_ID}?callback=widgetCallback`;
const res = await fetch(apiUrl, {
	headers: { Accept: "*/*", "User-Agent": UA, Referer: CAL },
});
if (!res.ok) throw new Error(`Prekindle API HTTP ${res.status}`);
const raw = await res.text();
const jsonText = raw.replace(/^widgetCallback\(/, "").replace(/\);?\s*$/, "");
const payload = JSON.parse(jsonText);
const apiEvents = payload.events ?? [];
console.log(`API events: ${apiEvents.length}`);

const events = [];
const seen = new Set();
for (const e of apiEvents) {
	const headliner = (e.headliner || e.lineup?.[0] || e.title || "").trim();
	const title = (e.title || headliner || "").trim();
	if (!title || !e.date || !e.time) continue;
	let starts_at;
	try {
		starts_at = parseLocalIso(e.date, e.time);
	} catch {
		continue;
	}
	if (+new Date(starts_at) < Date.now() - 12 * 3600e3) continue;
	const support = (e.lineup || [])
		.map((s) => String(s || "").trim())
		.filter((s) => s && s.toLowerCase() !== headliner.toLowerCase());
	const ticket_url =
		e.thirdPartyLink ||
		(e.promoId ? `https://www.prekindle.com/checkout/id/${e.promoId}` : null);
	const source_url = e.id
		? `https://mohawkaustin.com/event/?id=${encodeURIComponent(e.id)}`
		: CAL;
	const key = `${title.toLowerCase()}|${starts_at.slice(0, 16)}`;
	if (seen.has(key)) continue;
	seen.add(key);

	let description = stripHtml(e.description);
	if (support.length) {
		const feat = `Featuring ${support.join(", ")}.`;
		description = description ? `${feat} ${description}` : feat;
	}

	events.push({
		title,
		band: headliner,
		starts_at,
		ends_at: null,
		ticket_url,
		source_url,
		source_event_id: e.promoId || e.id,
		image_url: e.imageUrl || null,
		description,
		price_text: e.price != null ? (Number(e.price) === 0 ? "Free / RSVP" : `$${e.price}`) : null,
		raw_date_text: [
			e.date,
			e.doorsTime ? `doors ${e.doorsTime}` : null,
			e.time ? `show ${e.time}` : null,
			support.length ? `featuring ${support.join(", ")}` : null,
		]
			.filter(Boolean)
			.join(" · "),
		confidence: 0.95,
	});
}
events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
console.log(`Upcoming: ${events.length}`);
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
		e.title.slice(0, 40),
		e.ticket_url ? "🎟" : "·",
		e.image_url ? "🖼" : "",
	);
}

if (probeOnly) {
	console.log("\n--probe-only done");
	process.exit(events.length ? 0 : 2);
}

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();

await sb
	.from("ingested_events")
	.update({ review_status: "rejected", reviewed_at: new Date().toISOString() })
	.eq("venue_id", venue.id)
	.eq("review_status", "pending");

const { data: run, error: runErr } = await sb
	.from("ingestion_runs")
	.insert({
		site_id: site.id,
		venue_id: venue.id,
		status: "success",
		finished_at: new Date().toISOString(),
	})
	.select("id")
	.single();
if (runErr) throw new Error(runErr.message);

const rows = [];
for (let i = 0; i < events.length; i++) {
	const e = events[i];
	const hosted = e.image_url ? await rehost(site.id, e.image_url) : null;
	const desc =
		e.description ||
		`Catch ${e.band || e.title} live at The Mohawk in Austin.`;
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
		source_partner: "prekindle",
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
			price_text: e.price_text,
			confidence: e.confidence,
			import_method: "prekindle_organizer_api",
			platform: "prekindle",
			mohawk_event_url: e.source_url,
		},
	});
	if ((i + 1) % 10 === 0) console.log(`  rehost ${i + 1}/${events.length}`);
}

for (let i = 0; i < rows.length; i += 40) {
	const { error } = await sb.from("ingested_events").insert(rows.slice(i, i + 40));
	if (error) throw new Error(error.message);
}

await sb
	.from("venue_event_sources")
	.update({
		last_scrape_status: "success",
		last_scrape_at: new Date().toISOString(),
		last_scrape_error: null,
		updated_at: new Date().toISOString(),
	})
	.eq("venue_id", venue.id)
	.eq("is_enabled", true);

const imgs = rows.filter((r) => r.raw_payload.image_url).length;
const tickets = rows.filter((r) => r.raw_payload.ticket_url).length;
console.log(`\n=== ${venue.name} === staged ${rows.length}  images ${imgs}  tickets ${tickets}`);
console.log("Admin: https://events-platform-admin.ben-745.workers.dev/ingestion");
console.log("Filter: The Mohawk / the-mohawk");
