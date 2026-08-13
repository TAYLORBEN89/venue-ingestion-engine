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

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();

const { count: artists } = await supabase
	.from("artists")
	.select("id", { count: "exact", head: true })
	.eq("site_id", site.id);

const { count: pending } = await supabase
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending");

const { data: runs } = await supabase
	.from("ingestion_runs")
	.select("id, status, error_message, started_at, finished_at, venue_id, venues(name, slug)")
	.order("started_at", { ascending: false })
	.limit(5);

console.log(`Artists: ${artists ?? 0} | Pending ingestion: ${pending ?? 0}\n`);
console.log("Recent ingestion runs:");
for (const r of runs ?? []) {
	console.log(`  ${r.status} | ${r.venues?.name ?? r.venue_id}`);
	if (r.error_message) console.log(`    ${r.error_message.slice(0, 300)}`);
}

const { data: pendingEvents } = await supabase
	.from("ingested_events")
	.select("raw_title, parsed_starts_at, venues(name)")
	.eq("review_status", "pending")
	.order("created_at", { ascending: false })
	.limit(10);

if (pendingEvents?.length) {
	console.log("\nPending events:");
	for (const e of pendingEvents) console.log(`  • ${e.raw_title} @ ${e.venues?.name}`);
}