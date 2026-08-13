/**
 * Stage Poodie's calendar slots into the admin ingestion review queue.
 *
 *   node apps/ingestion/venues/poodies-hilltop/scrape-poodies-calendar.mjs
 *   node apps/ingestion/venues/poodies-hilltop/poodies-stage-queue.mjs
 *   node apps/ingestion/venues/poodies-hilltop/poodies-stage-queue.mjs --from=2026-07-26 --include-optional
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const VENUE_ID = "f327605b-d032-4e43-a027-fb227af27682";
const SITE_ID = "51177cff-babf-4a36-a258-834f4e880b87";
const VENUE_SLUG = "poodie-s-hilltop-roadhouse";
const TZ = "America/Chicago";
const MAX_HOURS = 2;
const SOURCE_PARTNER = "poodies_net";

function loadEnv() {
	const env = { ...process.env };
	for (const f of [
		path.join(ROOT, "apps/ingestion/.dev.vars"),
		path.join(ROOT, "apps/admin/.env.local"),
	]) {
		if (!fs.existsSync(f)) continue;
		for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
			if (!line || line.startsWith("#") || !line.includes("=")) continue;
			const i = line.indexOf("=");
			const k = line.slice(0, i).trim();
			let v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
			if (k && env[k] === undefined) env[k] = v;
		}
	}
	return env;
}

function arg(name) {
	const p = process.argv.find((a) => a.startsWith(`--${name}=`));
	return p ? p.slice(name.length + 3) : null;
}
function hasFlag(name) {
	return process.argv.includes(`--${name}`);
}

function chicagoLocalToIso(dateYmd, hour, minute) {
	const [y, m, d] = dateYmd.split("-").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: TZ,
			timeZoneName: "shortOffset",
			hour12: false,
		})
			.formatToParts(guess)
			.filter((p) => p.type !== "literal")
			.map((p) => [p.type, p.value]),
	);
	const offStr = parts.timeZoneName || "GMT-6";
	const om = offStr.match(/GMT([+-])(\d+)(?::(\d+))?/i);
	let offsetMin = -6 * 60;
	if (om) {
		const sign = om[1] === "+" ? 1 : -1;
		offsetMin = sign * (Number(om[2]) * 60 + Number(om[3] || 0));
	}
	const localAsUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
	return new Date(localAsUtc - offsetMin * 60 * 1000).toISOString();
}

function applyEnds(slots) {
	const byDay = new Map();
	for (const s of slots) {
		if (!byDay.has(s.date)) byDay.set(s.date, []);
		byDay.get(s.date).push(s);
	}
	const out = [];
	for (const [, daySlots] of byDay) {
		const sorted = [...daySlots].sort((a, b) => a.start.localeCompare(b.start));
		for (let i = 0; i < sorted.length; i++) {
			const cur = sorted[i];
			const [ch, cm] = cur.start.split(":").map(Number);
			const startM = ch * 60 + cm;
			let endM;
			if (i < sorted.length - 1) {
				const [nh, nm] = sorted[i + 1].start.split(":").map(Number);
				endM = startM + Math.min(Math.max(nh * 60 + nm - startM, 0), MAX_HOURS * 60);
			} else {
				endM = startM + MAX_HOURS * 60;
			}
			if (endM <= startM) endM = startM + MAX_HOURS * 60;
			out.push({ ...cur, endHour: Math.floor(endM / 60), endMinute: endM % 60 });
		}
	}
	return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

function fingerprint(venueId, title, startsAt) {
	const raw = `${venueId}|${String(title).toLowerCase().trim()}|${startsAt}`;
	return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function bandName(slot) {
	if (slot.kind === "song_swap" || /songwriters?\s+showcase/i.test(slot.title)) {
		return [slot.host, slot.guest].filter(Boolean).join(" / ") || slot.title;
	}
	return slot.face || slot.artists?.[0] || slot.title;
}

function intro(slot) {
	const venue = "Poodie's Hilltop Roadhouse";
	if (slot.host && slot.guest) {
		return `${slot.host} hosts with ${slot.guest} at ${venue}.`;
	}
	if (slot.face) return `${slot.face} live at ${venue}.`;
	return `${slot.title} at ${venue}.`;
}

const env = loadEnv();
const sb = createClient(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const from = arg("from") || new Date().toISOString().slice(0, 10);
const to = arg("to") || "2099-12-31";
const includeOptional = hasFlag("include-optional");

const slotsPath = path.join(__dirname, "slots-merged.json");
if (!fs.existsSync(slotsPath)) {
	console.error("Run scrape-poodies-calendar.mjs first");
	process.exit(1);
}
const { slots: raw } = JSON.parse(fs.readFileSync(slotsPath, "utf8"));
let slots = raw.filter((s) => s.date >= from && s.date <= to);
if (!includeOptional) slots = slots.filter((s) => !s.optional);
slots = applyEnds(slots);

console.log(`=== Stage Poodie's calendar → ingestion queue ===`);
console.log(`Window ${from} → ${to}  slots=${slots.length}  optional=${includeOptional}\n`);

// Ensure calendar_url on venue points at partner
await sb
	.from("venues")
	.update({
		calendar_url: "https://poodies.net/calendar.html",
		website_url: "https://poodies.net/",
		updated_at: new Date().toISOString(),
	})
	.eq("id", VENUE_ID);

// Required: ingestion_runs.site_id + venue_id (ingestion_run_id is NOT NULL on rows)
let runId = null;
{
	const { data, error } = await sb
		.from("ingestion_runs")
		.insert({
			site_id: SITE_ID,
			venue_id: VENUE_ID,
			status: "success",
			started_at: new Date().toISOString(),
			finished_at: new Date().toISOString(),
		})
		.select("id")
		.single();
	if (error) {
		console.error("ingestion_runs insert failed:", error.message);
		process.exit(1);
	}
	runId = data.id;
	console.log("ingestion_run", runId);
}

let staged = 0;
let skipped = 0;
let revived = 0;
let failed = 0;

for (const slot of slots) {
	const [sh, sm] = slot.start.split(":").map(Number);
	const startsAt = chicagoLocalToIso(slot.date, sh, sm);
	let endDate = slot.date;
	let eh = slot.endHour;
	let em = slot.endMinute;
	if (eh >= 24) {
		const [y, m, d] = slot.date.split("-").map(Number);
		const next = new Date(Date.UTC(y, m - 1, d + 1));
		endDate = next.toISOString().slice(0, 10);
		eh = eh % 24;
	}
	const endsAt = chicagoLocalToIso(endDate, eh, em);
	const source_event_id = `poodies-net:${slot.date}T${slot.start}:${slot.title}`
		.toLowerCase()
		.replace(/[^a-z0-9:.\-]+/g, "-")
		.slice(0, 180);
	const fp = fingerprint(VENUE_ID, slot.title, startsAt);
	const extracted = bandName(slot);

	const { data: existing } = await sb
		.from("ingested_events")
		.select("id, review_status")
		.eq("venue_id", VENUE_ID)
		.eq("source_event_id", source_event_id)
		.maybeSingle();

	const payload = {
		description: intro(slot),
		event_intro: intro(slot),
		price_text: slot.cover || null,
		ticket_url: null,
		image_url: null,
		confidence: 0.9,
		import_method: "poodies_calendar",
		platform: "poodies_net",
		publish_mode: "draft",
		category_slug: "live-music",
		schema_type: "MusicEvent",
		genres: ["live-music"],
		original_title: slot.title,
		fetched_event_title: slot.title,
		fetched_artist_text: extracted,
		_poodies_slot: slot,
		_poodies_source: slot.source || null,
		host: slot.host || null,
		guest: slot.guest || null,
		face: slot.face || null,
		artists: slot.artists || [],
		kind: slot.kind || null,
	};

	if (existing) {
		if (existing.review_status === "rejected" || existing.review_status === "pending") {
			const { error } = await sb
				.from("ingested_events")
				.update({
					review_status: "pending",
					reviewed_at: null,
					raw_title: slot.title,
					extracted_band_name: extracted,
					parsed_starts_at: startsAt,
					parsed_ends_at: endsAt,
					raw_date_text: `${slot.date} ${slot.start}`,
					source_url: "https://poodies.net/calendar.html",
					source_partner: SOURCE_PARTNER,
					fingerprint: fp,
					artist_match_status: "unmatched",
					raw_payload: payload,
					...(runId ? { ingestion_run_id: runId } : {}),
				})
				.eq("id", existing.id);
			if (error) {
				console.log("REVIVE FAIL", slot.date, slot.title, error.message);
				failed++;
			} else {
				console.log(existing.review_status === "rejected" ? "REVIVE" : "UPDATE", slot.date, slot.start, slot.title);
				if (existing.review_status === "rejected") revived++;
				else skipped++;
			}
		} else {
			console.log("SKIP", existing.review_status, slot.date, slot.title);
			skipped++;
		}
		continue;
	}

	const row = {
		ingestion_run_id: runId,
		venue_id: VENUE_ID,
		raw_title: slot.title,
		raw_date_text: `${slot.date} ${slot.start}`,
		parsed_starts_at: startsAt,
		parsed_ends_at: endsAt,
		source_url: "https://poodies.net/calendar.html",
		source_event_id,
		fingerprint: fp,
		source_partner: SOURCE_PARTNER,
		extracted_band_name: extracted,
		artist_match_status: "unmatched",
		match_status: "new",
		review_status: "pending",
		raw_payload: payload,
	};

	const { error } = await sb.from("ingested_events").insert(row);
	if (error) {
		console.log("FAIL", slot.date, slot.title, error.message);
		failed++;
	} else {
		console.log("STAGE", slot.date, slot.start, slot.title);
		staged++;
	}
}

const { count: pending } = await sb
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("venue_id", VENUE_ID)
	.eq("review_status", "pending");

console.log(`\nDone. staged=${staged} revived=${revived} skipped=${skipped} failed=${failed}`);
console.log(`Pending in queue for Poodie's: ${pending ?? 0}`);
console.log(`Admin → /ingestion  filter venue ${VENUE_SLUG} / source ${SOURCE_PARTNER}`);
