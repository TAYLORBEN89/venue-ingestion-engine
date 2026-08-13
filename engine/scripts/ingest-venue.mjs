import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const slug = process.argv[2];
if (!slug) {
	console.error("Usage: node scripts/ingest-venue.mjs <venue-slug>");
	process.exit(1);
}

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
const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";

const { data: venue } = await supabase.from("venues").select("id, name").eq("slug", slug).single();
if (!venue) throw new Error(`Venue not found: ${slug}`);

const res = await fetch(`${WORKER}/ingest`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ venueId: venue.id }),
});
const data = await res.json();
console.log(venue.name, data);