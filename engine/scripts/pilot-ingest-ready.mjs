/**
 * @deprecated Use pilot-ingest-new.mjs — this script now delegates to new-venue-only ingest.
 * Usage: node scripts/pilot-ingest-ready.mjs [--limit=10]
 */
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const limit = process.argv.find((a) => a.startsWith("--limit=")) ?? "--limit=8";

console.log("pilot-ingest-ready.mjs → pilot-ingest-new.mjs (new venues only)\n");

const result = spawnSync("node", ["scripts/pilot-ingest-new.mjs", limit], {
	cwd: resolve(__dirname, ".."),
	stdio: "inherit",
	shell: true,
});
process.exit(result.status ?? 1);