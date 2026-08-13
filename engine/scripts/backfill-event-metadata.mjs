/**
 * Backfill genres + event_categories on existing ingested events.
 * Usage: node scripts/backfill-event-metadata.mjs [--dry-run]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { classifyEventCategorySlug, inferEventGenres } from "./lib/classify-event-metadata.mjs";

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
const dryRun = process.argv.includes("--dry-run");

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: categories } = await supabase
	.from("categories")
	.select("id, slug")
	.eq("site_id", site.id)
	.eq("kind", "event");
const categoryIdsBySlug = Object.fromEntries((categories ?? []).map((c) => [c.slug, c.id]));

const { data: events } = await supabase
	.from("events")
	.select("id, title, description, genres, venue_id, ingested_event_id, venues(site_id, venue_categories(categories(slug)))")
	.eq("site_id", site.id)
	.in("source", ["partner_import", "ai_ingested"]);

let genreUpdates = 0;
let categoryLinks = 0;

for (const event of events ?? []) {
	const venueSlugs = (event.venues?.venue_categories ?? [])
		.map((vc) => vc.categories?.slug)
		.filter(Boolean);

	const categorySlug = classifyEventCategorySlug({
		title: event.title,
		description: event.description,
		venueCategorySlugs: venueSlugs,
	});
	const categoryId = categoryIdsBySlug[categorySlug];
	const genres =
		event.genres?.length > 0
			? event.genres
			: inferEventGenres({
					title: event.title,
					description: event.description,
					categorySlug,
				});

	const { count: catCount } = await supabase
		.from("event_categories")
		.select("id", { count: "exact", head: true })
		.eq("event_id", event.id);

	const needsGenres = !event.genres?.length && genres.length > 0;
	const needsCategory = !catCount && categoryId;

	if (!needsGenres && !needsCategory) continue;

	console.log(`${event.title}`);
	if (needsGenres) console.log(`  genres: ${genres.join(", ")}`);
	if (needsCategory) console.log(`  category: ${categorySlug}`);

	if (dryRun) continue;

	if (needsGenres) {
		const { error } = await supabase.from("events").update({ genres, updated_at: new Date().toISOString() }).eq("id", event.id);
		if (error) console.error(`  genre update failed: ${error.message}`);
		else genreUpdates++;
	}

	if (needsCategory) {
		const { error } = await supabase.from("event_categories").upsert({ event_id: event.id, category_id: categoryId });
		if (error) console.error(`  category link failed: ${error.message}`);
		else categoryLinks++;
	}
}

console.log(`\nDone${dryRun ? " (dry run)" : ""}: ${genreUpdates} genre updates, ${categoryLinks} category links`);