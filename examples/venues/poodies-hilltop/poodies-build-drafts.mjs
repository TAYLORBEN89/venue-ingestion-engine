/**
 * Build draft events at Poodie's from slots-merged.json.
 *
 *   node apps/ingestion/venues/poodies-hilltop/poodies-build-drafts.mjs --from=2026-07-26 --to=2026-08-31 --dry-run
 *   node apps/ingestion/venues/poodies-hilltop/poodies-build-drafts.mjs --from=2026-07-26 --to=2026-08-08
 *   node apps/ingestion/venues/poodies-hilltop/poodies-build-drafts.mjs --from=2026-07-26 --to=2026-08-31 --include-optional
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const VENUE_SLUG = "poodie-s-hilltop-roadhouse";
const TZ = "America/Chicago";
const MAX_HOURS = 2;

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

function norm(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const ALIASES = {
	"bb morse": "B.B. Morse",
	"b.b. morse": "B.B. Morse",
	"ab hill": "A.B. Hill",
	"a.b. hill": "A.B. Hill",
	"ricke bros": "Ricke Brothers",
	"ricke brothers": "Ricke Brothers",
	"the wainthrops": "The Wainthropps",
	wainthrops: "The Wainthropps",
	"the switcharoos": "Switcharoos",
	switcharoos: "Switcharoos",
	morningstar: "Morningstar",
	"christopher seymore": "Christopher Seymour",
	"christopher seymour": "Christopher Seymour",
	"madam radar duo": "Madam Radar Duo",
	"forlini cross": "Forlini & Cross",
	"forlini & cross": "Forlini & Cross",
	"doug gill": "Doug Gill & Lynn Langham",
	"lynn langham": "Doug Gill & Lynn Langham",
	"doug gill & lynn langham": "Doug Gill & Lynn Langham",
	"tj wicks & the top hands": "TJ Wicks and the Top Hands",
	"tj wicks and the top hands": "TJ Wicks and the Top Hands",
};

function resolveName(q) {
	return ALIASES[norm(q)] || q;
}

function scoreMatch(query, candidate) {
	const q = norm(resolveName(query));
	const c = norm(candidate);
	if (!q || !c) return 0;
	if (c.length < 3 || /^le\s*$/i.test(c)) return 0;
	if (/\d\s*pm\b/i.test(c) || /\d\s*am\b/i.test(c)) return 0;
	if (q === c) return 100;
	const shorter = q.length <= c.length ? q : c;
	const longer = q.length <= c.length ? c : q;
	if (shorter.length >= 5 && longer.includes(shorter)) {
		const re = new RegExp(`(?:^|\\s)${shorter.replace(/\s+/g, "\\s+")}(?:\\s|$)`);
		if (re.test(longer)) return 85;
	}
	const qt = q.split(" ").filter((t) => t.length > 1);
	const ct = new Set(c.split(" ").filter((t) => t.length > 1));
	if (!qt.length) return 0;
	let hit = 0;
	for (const t of qt) if (ct.has(t)) hit++;
	const ratio = hit / qt.length;
	if (ratio >= 1 && qt.length >= 2) return 90;
	if (ratio >= 0.8 && qt.length >= 2) return 70;
	return 0;
}

function findArtist(artists, query) {
	if (!query) return null;
	const preferred = resolveName(query);
	const qNorm = norm(query);
	const isDuo = qNorm.includes("madam radar duo");
	let best = null;
	let bestScore = 0;
	for (const a of artists) {
		if (isDuo && norm(a.name) === "madam radar") continue;
		if (!isDuo && qNorm === "madam radar" && /duo/i.test(a.name)) continue;
		const sc = Math.max(scoreMatch(query, a.name), scoreMatch(preferred, a.name));
		if (sc > bestScore) {
			bestScore = sc;
			best = a;
		}
	}
	return bestScore >= 70 ? best : null;
}

function isSongwritersShowcase(slot) {
	const t = String(slot.title || "");
	return (
		slot.kind === "song_swap" ||
		/songwriters?\s+showcase/i.test(t) ||
		/song\s*swap/i.test(t)
	);
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
				const nextM = nh * 60 + nm;
				const gap = nextM - startM;
				endM = startM + Math.min(Math.max(gap, 0), MAX_HOURS * 60);
			} else {
				endM = startM + MAX_HOURS * 60;
			}
			if (endM <= startM) endM = startM + MAX_HOURS * 60;
			out.push({
				...cur,
				endHour: Math.floor(endM / 60),
				endMinute: endM % 60,
			});
		}
	}
	return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

function chicagoLocalToIso(dateYmd, hour, minute) {
	const [y, m, d] = dateYmd.split("-").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: TZ,
			timeZoneName: "shortOffset",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
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

function slugify(text) {
	return text
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 50);
}

async function allocateUniqueEventSlug(sb, siteId, title) {
	const base = slugify(title) || "event";
	for (let i = 0; i < 200; i++) {
		const trySlug = i === 0 ? base : `${base}-${i + 1}`;
		const { data } = await sb
			.from("events")
			.select("id")
			.eq("site_id", siteId)
			.eq("slug", trySlug)
			.limit(1);
		if (!data?.length) return trySlug;
	}
	return `${base}-${Date.now().toString(36)}`;
}

function shortIntro(slot, venueName, names) {
	const list = names.filter(Boolean);
	if (isSongwritersShowcase(slot) && slot.host && slot.guest) {
		return `${slot.host} hosts Songwriters Showcase with special guest ${slot.guest} at ${venueName}.`;
	}
	if (list.length === 0) return `${slot.title} at ${venueName}.`;
	if (list.length === 1) return `${list[0]} live at ${venueName}.`;
	if (list.length === 2) return `${list[0]} with ${list[1]} at ${venueName}.`;
	return `${list[0]} with ${list.slice(1).join(", ")} at ${venueName}.`;
}

function roleForName(slot, name, faceName) {
	if (slot.host && norm(name) === norm(slot.host)) return "host";
	if (slot.guest && norm(name) === norm(slot.guest)) return "special_guest";
	if (faceName && norm(name) === norm(faceName)) return "headliner";
	return "support";
}

// --- main ---
const dryRun = hasFlag("dry-run");
const includeOptional = hasFlag("include-optional");
const from = arg("from") || new Date().toISOString().slice(0, 10);
const to = arg("to") || "2099-12-31";

const slotsPath = path.join(__dirname, "slots-merged.json");
if (!fs.existsSync(slotsPath)) {
	console.error("Missing slots-merged.json — run scrape-poodies-calendar.mjs first");
	process.exit(1);
}
const { slots: rawSlots } = JSON.parse(fs.readFileSync(slotsPath, "utf8"));
let slots = rawSlots.filter((s) => s.date >= from && s.date <= to);
if (!includeOptional) slots = slots.filter((s) => !s.optional);
slots = applyEnds(slots);

console.log(`=== Poodie's build drafts ===`);
console.log(`Window ${from} → ${to}  (${slots.length} slots)`);
console.log(`Mode: ${dryRun ? "DRY-RUN" : "WRITE drafts"}  optional: ${includeOptional ? "include" : "skip"}\n`);

const env = loadEnv();
const sb = createClient(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: venue, error: vErr } = await sb
	.from("venues")
	.select("id, name, slug, site_id, status")
	.eq("slug", VENUE_SLUG)
	.is("deleted_at", null)
	.maybeSingle();
if (vErr || !venue) {
	console.error("Venue not found", VENUE_SLUG, vErr?.message);
	process.exit(1);
}
console.log(`Venue: ${venue.name} (${venue.id})\n`);

const { data: catRows } = await sb
	.from("categories")
	.select("id, slug")
	.eq("site_id", venue.site_id)
	.eq("kind", "event")
	.in("slug", ["live-music", "food-drink"])
	.is("deleted_at", null);
const categoryIds = (catRows || []).map((c) => c.id);
console.log(
	"Categories:",
	(catRows || []).map((c) => c.slug).join(" + ") || "(none)",
);

const artists = [];
for (let fromIdx = 0; ; fromIdx += 1000) {
	const { data, error } = await sb
		.from("artists")
		.select(
			"id, name, slug, bio, featured_media_id, genres, status, youtube_id, youtube_embed",
		)
		.is("deleted_at", null)
		.range(fromIdx, fromIdx + 999);
	if (error) throw error;
	if (!data?.length) break;
	artists.push(...data);
	if (data.length < 1000) break;
}

let created = 0;
let skipped = 0;
let failed = 0;

for (const slot of slots) {
	const label = `${slot.date} ${slot.start} ${slot.title}`;
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

	const faceName = slot.face || null;
	const faceArtist = faceName ? findArtist(artists, faceName) : null;

	// Ordered bill: song_swap guest first (hero), else face first
	const orderedNames = [];
	const pushName = (n) => {
		if (!n) return;
		if (orderedNames.some((x) => norm(x) === norm(n))) return;
		if (faceName && norm(faceName).includes("madam radar duo") && norm(n) === "madam radar")
			return;
		orderedNames.push(n);
	};
	if (isSongwritersShowcase(slot)) {
		pushName(slot.guest);
		pushName(slot.host);
		pushName(faceName);
	} else {
		pushName(faceName);
		pushName(slot.host);
		pushName(slot.guest);
	}
	for (const a of slot.artists || []) pushName(a);

	const links = [];
	const seenIds = new Set();
	const introNames = [];
	const missingNames = [];
	let order = 0;
	for (const name of orderedNames) {
		const a = findArtist(artists, name);
		if (!a) {
			missingNames.push(name);
			if (!introNames.some((x) => norm(x) === norm(name))) introNames.push(name);
			continue;
		}
		if (seenIds.has(a.id)) continue;
		seenIds.add(a.id);
		const role = roleForName(slot, name, faceName);
		const billingRole =
			order === 0
				? role === "host"
					? "host"
					: role === "special_guest"
						? "special_guest"
						: "headliner"
				: role;
		links.push({ artist: a, order: order++, role: billingRole });
		if (!introNames.some((x) => norm(x) === norm(a.name))) introNames.push(a.name);
	}

	// Readable intro order for showcase
	let introOrder = introNames;
	if (isSongwritersShowcase(slot)) {
		introOrder = [];
		for (const n of [slot.host, slot.guest, faceName, ...(slot.artists || [])]) {
			if (!n) continue;
			const display = findArtist(artists, n)?.name || n;
			if (!introOrder.some((x) => norm(x) === norm(display))) introOrder.push(display);
		}
	}

	const intro = shortIntro(slot, venue.name, introOrder);
	const fillArtist = links[0]?.artist || faceArtist || null;
	const bio = fillArtist?.bio?.trim() || null;
	const description = bio ? `${intro}\n\n${bio}` : intro;
	const mediaId = fillArtist?.featured_media_id || null;
	const genres = Array.isArray(fillArtist?.genres) ? fillArtist.genres : [];

	const { data: existing } = await sb
		.from("events")
		.select("id, slug, status")
		.eq("venue_id", venue.id)
		.eq("starts_at", startsAt)
		.eq("title", slot.title)
		.is("deleted_at", null)
		.maybeSingle();

	if (existing) {
		console.log(`  SKIP exists     ${label}  ${existing.slug?.slice(0, 40)} (${existing.status})`);
		skipped++;
		continue;
	}

	if (dryRun) {
		const faceLabel = faceArtist
			? `${faceArtist.name}${mediaId ? " +photo" : " NO_PHOTO"}`
			: faceName
				? `${faceName} MISS`
				: "no face";
		console.log(
			`  DRY            ${label}  end=${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}  face=${faceLabel}  links=${links.map((l) => l.artist.name).join("|") || "—"}`,
		);
		created++;
		continue;
	}

	const slug = await allocateUniqueEventSlug(sb, venue.site_id, slot.title);
	const record = {
		site_id: venue.site_id,
		venue_id: venue.id,
		slug,
		title: slot.title,
		description,
		event_intro: intro,
		starts_at: startsAt,
		ends_at: endsAt,
		ticket_url: null,
		price_text: slot.cover || null,
		is_featured: false,
		status: "draft",
		source: "manual",
		featured_media_id: mediaId,
		genres,
		youtube_id: fillArtist?.youtube_id || null,
		youtube_embed: fillArtist?.youtube_embed || null,
		seo_title: `${slot.title} | ${venue.name}`,
		seo_description: intro.slice(0, 160),
		focus_keyphrase: slot.title,
		schema_type: "MusicEvent",
		field_sources: {
			title: "partner",
			starts_at: "partner",
			ends_at: "generated",
			description: fillArtist ? "catalog" : "generated",
			event_intro: "generated",
			featured_media_id: mediaId ? "catalog" : null,
			_poodies_fixture: true,
			_poodies_slot: `${slot.date}T${slot.start}`,
			_poodies_source: slot.source || null,
		},
		updated_at: new Date().toISOString(),
	};

	const { data: row, error } = await sb.from("events").insert(record).select("id, slug").single();
	if (error) {
		console.log(`  FAIL           ${label}  ${error.message}`);
		failed++;
		continue;
	}

	if (links.length) {
		const linkRows = links.map((l) => ({
			event_id: row.id,
			artist_id: l.artist.id,
			billing_order: l.order,
			role: l.role,
		}));
		const { error: linkErr } = await sb.from("event_artists").upsert(linkRows, {
			onConflict: "event_id,artist_id",
		});
		if (linkErr) {
			const simple = links.map((l) => ({ event_id: row.id, artist_id: l.artist.id }));
			await sb.from("event_artists").upsert(simple, { onConflict: "event_id,artist_id" });
		}
	}

	if (categoryIds.length) {
		await sb.from("event_categories").upsert(
			categoryIds.map((category_id) => ({ event_id: row.id, category_id })),
			{ onConflict: "event_id,category_id" },
		);
	}

	console.log(`  OK             ${label}  /events/${row.slug}`);
	created++;
}

console.log(`\nDone. created/would-create=${created}  skipped=${skipped}  failed=${failed}`);
console.log(`Review drafts in admin Events for ${venue.name}.\n`);
if (failed) process.exit(1);
