import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const instanceId = process.argv[2];
if (!instanceId) {
	console.error("Usage: node scripts/poll-ingest.mjs <workflow-instance-id>");
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

const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

for (let i = 0; i < 12; i++) {
	const res = await fetch(`${WORKER}/ingest/${instanceId}`);
	const wf = await res.json();
	console.log(`[${i + 1}] workflow: ${wf.status?.status ?? "?"}`);

	const { count: pending } = await supabase
		.from("ingested_events")
		.select("id", { count: "exact", head: true })
		.eq("review_status", "pending");

	const { data: runs, error: runsErr } = await supabase
		.from("ingestion_runs")
		.select("id, status, error_message, started_at, finished_at")
		.order("started_at", { ascending: false })
		.limit(1);

	if (runsErr) console.log("  runs error:", runsErr.message);
	else if (runs?.[0]) console.log("  latest run:", runs[0]);

	console.log(`  pending queue: ${pending ?? 0}`);

	if (wf.status?.status === "complete" || wf.status?.status === "errored") break;
	await new Promise((r) => setTimeout(r, 15000));
}

const { data: sample } = await supabase
	.from("ingested_events")
	.select("raw_title, parsed_starts_at, review_status, venue_id")
	.eq("review_status", "pending")
	.order("created_at", { ascending: false })
	.limit(8);

console.log("\nPending samples:");
console.log(JSON.stringify(sample, null, 2));