/**
 * Write short generic hype copy for Scoot Inn pending events:
 * band + date + venue — no "Extracted band:" junk.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

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
const VENUE = "The Historic Scoot Inn";
const CITY = "Austin";

/** Prefer headline act name before tour subtitle. */
function bandName(title) {
	const t = (title || "").trim();
	// "Artist: Tour Name" / "Artist - Tour Name"
	const m = t.match(/^(.+?)\s*[:–-]\s+.+$/);
	if (m && m[1].length >= 2 && m[1].length < 60) return m[1].trim();
	// "Artist "Tour Name""
	const q = t.match(/^(.+?)\s+"[^"]+"/);
	if (q) return q[1].trim();
	return t;
}

function formatDate(iso) {
	return new Date(iso).toLocaleDateString("en-US", {
		timeZone: "America/Chicago",
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

function formatTime(iso) {
	return new Date(iso).toLocaleTimeString("en-US", {
		timeZone: "America/Chicago",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Short hype blurb — band + date + Scoot Inn.
 * Rotates openers so the queue doesn't look copy-pasted.
 */
function buildDescription(title, startsAt, index) {
	const band = bandName(title);
	const date = formatDate(startsAt);
	const time = formatTime(startsAt);
	const openers = [
		`Catch ${band} live at ${VENUE} on ${date}.`,
		`${band} hits the stage at ${VENUE} on ${date}.`,
		`Don't miss ${band} at ${VENUE} — ${date}.`,
		`${band} brings the heat to ${VENUE} on ${date}.`,
		`See ${band} under the lights at ${VENUE} on ${date}.`,
		`${band} takes over ${VENUE} on ${date}.`,
	];
	const open = openers[index % openers.length];
	return `${open} Doors energy, East Austin outdoor-venue vibes, and a night built for ${CITY} live music fans. Showtime around ${time}. Grab tickets and get there early.`;
}

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id, name")
	.eq("site_id", site.id)
	.eq("slug", "the-historic-scoot-inn")
	.single();

const { data: rows } = await sb
	.from("ingested_events")
	.select("id, raw_title, parsed_starts_at, extracted_band_name, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.order("parsed_starts_at");

let n = 0;
for (let i = 0; i < (rows || []).length; i++) {
	const row = rows[i];
	const starts = row.parsed_starts_at;
	if (!starts) continue;
	const band = bandName(row.raw_title);
	const description = buildDescription(row.raw_title, starts, i);
	const payload = {
		...(row.raw_payload || {}),
		description,
		event_intro: description,
		// clear any junk fields that might surface oddly
		original_title: row.raw_payload?.original_title ?? row.raw_title,
	};

	const { error } = await sb
		.from("ingested_events")
		.update({
			extracted_band_name: band,
			raw_payload: payload,
		})
		.eq("id", row.id);
	if (error) console.error(error.message);
	else n++;
}

console.log(`Updated ${n} Scoot Inn pending events\n`);
const { data: sample } = await sb
	.from("ingested_events")
	.select("raw_title, extracted_band_name, parsed_starts_at, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.order("parsed_starts_at")
	.limit(5);
for (const r of sample || []) {
	console.log("---", r.raw_title);
	console.log("band:", r.extracted_band_name);
	console.log(r.raw_payload?.description);
	console.log();
}
