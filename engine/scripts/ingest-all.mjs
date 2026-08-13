/**
 * @deprecated Re-ingests ALL venues including completed pilots. Use pilot-new.mjs instead.
 * Usage: node scripts/ingest-all.mjs [--wait]
 */
console.warn("DEPRECATED: use `node scripts/pilot-new.mjs ingest` for new venues only.\n");
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
const WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";
const wait = process.argv.includes("--wait");
const approveAfter = process.argv.includes("--approve");

const { count: sourceCount } = await supabase
	.from("venue_event_sources")
	.select("id", { count: "exact", head: true })
	.eq("is_enabled", true);

console.log(`Enabled venue sources: ${sourceCount ?? 0}`);

const res = await fetch(`${WORKER}/ingest-all`, { method: "POST" });
const data = await res.json();
if (!res.ok) {
	console.error("Failed to start ingest-all:", data);
	process.exit(1);
}

const instanceId = data.instanceId;
console.log(`Scheduler workflow: ${instanceId}`);
console.log(`Status: ${data.status?.status ?? "unknown"}`);

if (!wait) {
	console.log("\nRe-run with --wait to poll until scheduler finishes, then check pending queue.");
	process.exit(0);
}

let schedulerDone = false;
for (let i = 0; i < 180; i++) {
	const statusRes = await fetch(`${WORKER}/ingest-all/${instanceId}`);
	const statusData = await statusRes.json();
	const wfStatus = statusData.status?.status ?? "?";
	const { count: pending } = await supabase
		.from("ingested_events")
		.select("id", { count: "exact", head: true })
		.eq("review_status", "pending");

	const { count: running } = await supabase
		.from("ingestion_runs")
		.select("id", { count: "exact", head: true })
		.eq("status", "running");

	console.log(`[${i + 1}] scheduler=${wfStatus} pending=${pending ?? 0} runs_active=${running ?? 0}`);

	if (wfStatus === "complete" || wfStatus === "errored") {
		schedulerDone = true;
		if ((running ?? 0) === 0) break;
	}

	await new Promise((r) => setTimeout(r, 30000));
}

if (!schedulerDone) console.log("\nScheduler still running — venue workflows may still be in flight.");

const { data: pendingRows } = await supabase
	.from("ingested_events")
	.select("id, raw_title, raw_payload, venues(slug, name)")
	.eq("review_status", "pending")
	.order("created_at", { ascending: false })
	.limit(5);

console.log("\nLatest pending samples:");
for (const row of pendingRows ?? []) {
	const p = row.raw_payload ?? {};
	const meta = p.category_id && p.genres?.length ? "metadata✓" : "metadata✗";
	const img = p.image_url ? "img✓" : "img✗";
	console.log(`  ${row.venues?.slug}: ${row.raw_title} [${meta} ${img}]`);
}

const { count: totalPending } = await supabase
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending");
console.log(`\nTotal pending: ${totalPending ?? 0}`);

if (approveAfter && (totalPending ?? 0) > 0) {
	console.log("\nRunning bulk approve (--all --with-metadata)...");
	const { spawnSync } = await import("child_process");
	const result = spawnSync("node", ["scripts/approve-pending.mjs", "--all", "--with-metadata"], {
		cwd: resolve(__dirname, ".."),
		stdio: "inherit",
		shell: true,
	});
	process.exit(result.status ?? 0);
}