/**
 * New-venue pilot workflow — never re-queues completed pilots.
 *
 *   node scripts/pilot-new.mjs status
 *   node scripts/pilot-new.mjs probe [--limit=20]
 *   node scripts/pilot-new.mjs ingest [--limit=5] [--probe-limit=40]
 *   node scripts/pilot-new.mjs approve [--with-metadata] [--with-images]
 *   node scripts/pilot-new.mjs run [--limit=5]   # ingest then wait, show next steps
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { loadNewPilotSources, PILOT_COMPLETED_SLUGS } from "./lib/pilot-venue-filters.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function run(script, extraArgs = []) {
	const result = spawnSync("node", [script, ...extraArgs], { cwd: root, stdio: "inherit", shell: true });
	if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function passthroughArgs(skip) {
	return process.argv.slice(2).filter((a) => !skip.includes(a.split("=")[0]));
}

const cmd = process.argv[2] ?? "status";
const passthrough = passthroughArgs([cmd]);

if (cmd === "probe") {
	run("scripts/pilot-probe-new.mjs", passthrough);
	process.exit(0);
}

if (cmd === "ingest") {
	run("scripts/pilot-ingest-new.mjs", passthrough);
	process.exit(0);
}

if (cmd === "approve") {
	console.error(
		"REFUSED: pilot-new never auto-approves.\n" +
			"AI / partner ingestion stays in the admin review queue until a human approves.\n" +
			"  → Review at admin /ingestion\n" +
			"  → Or, only if you explicitly want CLI bulk publish:\n" +
			"     node scripts/approve-pending.mjs --confirm-bulk-approve --all --new-only --with-metadata\n",
	);
	process.exit(2);
}

if (cmd === "run") {
	run("scripts/pilot-ingest-new.mjs", passthrough);
	console.log("\nWaiting 90s for workflows to finish…");
	await new Promise((r) => setTimeout(r, 90_000));
	run("scripts/pending-by-venue.mjs");
	console.log("\nReview pending rows in admin /ingestion (never auto-approved).");
	process.exit(0);
}

// status (default)
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

const newSources = await loadNewPilotSources(supabase, site.id);
const { count: pending } = await supabase
	.from("ingested_events")
	.select("id", { count: "exact", head: true })
	.eq("review_status", "pending");

const { data: pendingRows } = await supabase
	.from("ingested_events")
	.select("venues(slug)")
	.eq("review_status", "pending");

const newPendingSlugs = new Set();
for (const row of pendingRows ?? []) {
	const slug = row.venues?.slug;
	if (slug && !PILOT_COMPLETED_SLUGS.has(slug)) newPendingSlugs.add(slug);
}

console.log("\n=== New venue pilot status ===\n");
console.log(`Completed pilots (frozen): ${PILOT_COMPLETED_SLUGS.size}`);
console.log(`New venue pool:            ${newSources.length}`);
console.log(`Pending ingestion:         ${pending ?? 0}`);
console.log(`Pending from new venues:   ${newPendingSlugs.size} slugs`);
if (newPendingSlugs.size) console.log(`  ${[...newPendingSlugs].sort().join(", ")}`);

console.log("\nWorkflow:");
console.log("  1. node scripts/pilot-new.mjs probe --limit=20");
console.log("  2. node scripts/pilot-new.mjs ingest --limit=5");
console.log("  3. Human review + approve in admin /ingestion (never auto)");
console.log("\nOr: node scripts/pilot-new.mjs run --limit=5");