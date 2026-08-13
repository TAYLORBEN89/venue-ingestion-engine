/**
 * Seed artist catalog entries from published event titles at Wave 1 pilot venues.
 * Gives band-matching something to work with during shadow-mode ingestion.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devVars = readFileSync(resolve(__dirname, "../.dev.vars"), "utf8");
const env = Object.fromEntries(
	devVars
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const PILOT_SLUGS = [
	"antones-nightclub",
	"stubbs-bar-b-q",
	"moody-amphitheater-austin",
	"the-mohawk",
	"hotel-vegas",
];

function slugify(name) {
	return name
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 90);
}

function cleanTitle(title) {
	return title
		.replace(/\s+@\s+.+$/i, "")
		.replace(/\s+at\s+.+$/i, "")
		.replace(/\s+\|\s+.+$/i, "")
		.replace(/\s+-\s+(doors|show).+$/i, "")
		.trim();
}

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
if (!site) throw new Error("HeyAustin site not found");

const { data: venues } = await supabase
	.from("venues")
	.select("id, slug, name")
	.eq("site_id", site.id)
	.in("slug", PILOT_SLUGS);

const venueIds = (venues ?? []).map((v) => v.id);
const { data: events } = await supabase
	.from("events")
	.select("title, venue_id")
	.in("venue_id", venueIds)
	.eq("status", "published");

const { data: existing } = await supabase.from("artists").select("slug, name").eq("site_id", site.id);
const existingSlugs = new Set((existing ?? []).map((a) => a.slug));

const candidates = new Map();
for (const e of events ?? []) {
	const name = cleanTitle(e.title);
	if (!name || name.length < 3 || /trivia|open mic|comedy|karaoke|happy hour/i.test(name)) continue;
	const slug = slugify(name);
	if (existingSlugs.has(slug) || candidates.has(slug)) continue;
	candidates.set(slug, { site_id: site.id, slug, name, status: "published" });
}

const rows = [...candidates.values()].slice(0, 25);
if (rows.length === 0) {
	console.log("No new artist candidates from pilot venue events.");
	process.exit(0);
}

const { data: inserted, error } = await supabase.from("artists").insert(rows).select("slug, name");
if (error) {
	console.error("Insert failed:", error.message);
	process.exit(1);
}

console.log(`Seeded ${inserted?.length ?? 0} artists from pilot venue events:`);
for (const a of inserted ?? []) console.log(`  • ${a.name} (${a.slug})`);