/**
 * Dry-run: match slot faces/hosts/guests against artist catalog.
 *
 *   node apps/ingestion/venues/poodies-hilltop/poodies-check-artists.mjs
 *   node apps/ingestion/venues/poodies-hilltop/poodies-check-artists.mjs --from=2026-07-26
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function loadEnv() {
	const env = { ...process.env };
	for (const f of [
		path.join(ROOT, "engine/.dev.vars"),
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
};

function resolveName(q) {
	const k = norm(q);
	return ALIASES[k] || q;
}

function scoreMatch(query, candidate) {
	const q = norm(resolveName(query));
	const c = norm(candidate);
	if (!q || !c) return 0;
	// Reject garbage / ultra-short catalog names (e.g. "LE$", "Lie")
	if (c.length < 3 || /^le\s*$/i.test(c)) return 0;
	if (/\d\s*pm\b/i.test(c) || /\d\s*am\b/i.test(c)) return 0; // "Dakota Spellman 1PM"
	if (q === c) return 100;
	// Substring only when shorter side is a full meaningful phrase (min 5 chars)
	const shorter = q.length <= c.length ? q : c;
	const longer = q.length <= c.length ? c : q;
	if (shorter.length >= 5 && longer.includes(shorter)) {
		// Prefer whole-word containment
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
	return bestScore >= 70 ? { artist: best, score: bestScore } : null;
}

const env = loadEnv();
const sb = createClient(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const from = arg("from") || new Date().toISOString().slice(0, 10);

const slotsPath = path.join(__dirname, "slots-merged.json");
if (!fs.existsSync(slotsPath)) {
	console.error("Run scrape-poodies-calendar.mjs first (missing slots-merged.json)");
	process.exit(1);
}
const { slots } = JSON.parse(fs.readFileSync(slotsPath, "utf8"));
const upcoming = slots.filter((s) => s.date >= from && !s.optional);

const artists = [];
for (let fromIdx = 0; ; fromIdx += 1000) {
	const { data, error } = await sb
		.from("artists")
		.select("id, name, slug, featured_media_id, status")
		.is("deleted_at", null)
		.range(fromIdx, fromIdx + 999);
	if (error) throw error;
	if (!data?.length) break;
	artists.push(...data);
	if (data.length < 1000) break;
}

const names = new Set();
for (const s of upcoming) {
	for (const n of [s.face, s.host, s.guest, ...(s.artists || [])]) {
		if (n) names.add(n);
	}
}

console.log(`=== Poodie's artist check (from ${from}) ===`);
console.log(`slots ${upcoming.length}  unique names ${names.size}  catalog ${artists.length}\n`);

let hit = 0;
let miss = 0;
const missing = [];
for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
	const m = findArtist(artists, name);
	if (m) {
		hit++;
		const photo = m.artist.featured_media_id ? "photo" : "NO_PHOTO";
		console.log(`  OK  ${name} → ${m.artist.name} (${m.score}) ${photo}`);
	} else {
		miss++;
		missing.push(name);
		console.log(`  --  ${name}`);
	}
}
console.log(`\nmatched ${hit}  missing ${miss}`);
if (missing.length) {
	console.log("\nMissing catalog (link skip, still name in intro):");
	for (const n of missing) console.log(" -", n);
}
