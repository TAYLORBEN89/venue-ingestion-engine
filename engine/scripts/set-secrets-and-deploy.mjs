import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devVars = readFileSync(join(root, ".dev.vars"), "utf8");
const vars = {};
for (const line of devVars.split(/\r?\n/)) {
	const idx = line.indexOf("=");
	if (idx > 0) vars[line.slice(0, idx)] = line.slice(idx + 1);
}

const bulk = {
	SUPABASE_URL: vars.SUPABASE_URL,
	SUPABASE_SERVICE_ROLE_KEY: vars.SUPABASE_SERVICE_ROLE_KEY,
};
if (!bulk.SUPABASE_URL || !bulk.SUPABASE_SERVICE_ROLE_KEY) {
	console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars");
	process.exit(1);
}

const bulkPath = join(root, ".secrets-bulk.json");
writeFileSync(bulkPath, JSON.stringify(bulk));

function run(cmd, args) {
	const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
	console.log("Uploading Worker secrets...");
	run("node", ["node_modules/wrangler/bin/wrangler.js", "secret", "bulk", bulkPath]);
	console.log("Deploying ingestion worker...");
	run("node", ["node_modules/wrangler/bin/wrangler.js", "deploy"]);
	console.log("Done.");
} finally {
	try {
		unlinkSync(bulkPath);
	} catch {
		// ignore
	}
}