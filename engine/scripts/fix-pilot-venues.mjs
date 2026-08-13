/**
 * Align Wave 1 pilot venue calendar URLs with live event listing pages.
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

const UPDATES = [
	{ slug: "moody-amphitheater-austin", calendar_url: "https://moodyamphitheater.com/events-tickets" },
	{ slug: "the-mohawk", calendar_url: "https://mohawkaustin.com/shows" },
	{ slug: "hotel-vegas", calendar_url: "https://texashotelvegas.com/calendar/" },
];

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
if (!site) throw new Error("HeyAustin site not found");

for (const row of UPDATES) {
	const { data: venue, error } = await supabase
		.from("venues")
		.update({ calendar_url: row.calendar_url })
		.eq("site_id", site.id)
		.eq("slug", row.slug)
		.select("id, slug, name, calendar_url")
		.single();

	if (error) console.log(`SKIP ${row.slug}: ${error.message}`);
	else {
		console.log(`✓ ${venue.name} → ${venue.calendar_url}`);
		await supabase
			.from("venue_event_sources")
			.update({ calendar_url: row.calendar_url, updated_at: new Date().toISOString() })
			.eq("venue_id", venue.id);
	}
}