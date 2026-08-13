/**
 * List new pilot pool sorted by structured-feed priority (no worker probes).
 * Usage: node scripts/pilot-list-new.mjs [--limit=30]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { loadNewPilotSources } from "./lib/pilot-venue-filters.mjs";
import { pilotSourcePriority } from "./lib/pilot-source-priority.mjs";

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

const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 30);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const sources = await loadNewPilotSources(supabase, site.id);

console.log(`\nNew pilot pool: ${sources.length}\n`);
for (const source of sources.slice(0, limit)) {
	const v = source.venues;
	const url = (source.feed_url ?? v.event_feed_url ?? v.calendar_url ?? "").slice(0, 72);
	console.log(
		`${String(pilotSourcePriority(source)).padStart(3)}  ${v.slug.padEnd(32)} ${(source.platform_type ?? "auto").padEnd(16)} ${url}`,
	);
}