/**
 * Run the duplicate check against pending ingested_events.
 * Usage: node scripts/dedupe-pending.mjs [--venue=slug]
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

const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";
const venueSlug = process.argv.find((a) => a.startsWith("--venue="))?.split("=")[1];

let venueId;
if (venueSlug) {
	const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
	const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
	const { data: venue } = await supabase
		.from("venues")
		.select("id")
		.eq("site_id", site.id)
		.eq("slug", venueSlug)
		.maybeSingle();
	if (!venue) {
		console.error(`Venue not found: ${venueSlug}`);
		process.exit(1);
	}
	venueId = venue.id;
}

const res = await fetch(`${WORKER}/dedupe-pending`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(venueId ? { venueId } : {}),
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);
