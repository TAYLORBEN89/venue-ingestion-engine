/**
 * Unit tests for parse-lineup (no vitest in package — plain assert).
 *   node apps/ingestion/scripts/test-parse-lineup.mjs
 *
 * Compiles via tsx if available; else uses dynamic import of built logic
 * by evaluating TypeScript through a minimal transpile path.
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const srcFile = path.join(root, "src/lib/parse-lineup.ts");
const bandFile = path.join(root, "src/lib/parse-band-name.ts");

// Prefer tsx / jiti for TS import
async function loadModule() {
	// Try running via npx tsx
	const runner = path.join(__dirname, "test-parse-lineup-runner.ts");
	fs.writeFileSync(
		runner,
		`
import { parseLineupFromTitle, PARSE_LINEUP_FIXTURES, splitCoHeadliners } from "../src/lib/parse-lineup";

let failed = 0;
for (const fix of PARSE_LINEUP_FIXTURES) {
  const slots = parseLineupFromTitle(fix.input);
  const names = slots.map((s) => s.name);
  const head = slots[0]?.name;
  const okNames =
    names.length === fix.expectedNames.length &&
    names.every((n, i) => n.toLowerCase() === fix.expectedNames[i].toLowerCase());
  const okHead = (head || "").toLowerCase() === fix.headliner.toLowerCase();
  if (!okNames || !okHead) {
    failed++;
    console.error("FAIL:", fix.input);
    console.error("  got names:", names);
    console.error("  want:     ", fix.expectedNames);
    console.error("  got head: ", head, " want:", fix.headliner);
  } else {
    console.log("OK:", fix.input, "→", names.join(" | "));
  }
}

// Extra edge cases
const extra = [
  { input: "Gov't Mule", expect: ["Gov't Mule"] },
  { input: "An Evening with Lyle Lovett", expect: ["Lyle Lovett"] },
];
for (const e of extra) {
  const names = parseLineupFromTitle(e.input).map((s) => s.name);
  const ok = names.length === e.expect.length && names.every((n, i) => n.toLowerCase() === e.expect[i].toLowerCase());
  if (!ok) {
    failed++;
    console.error("FAIL extra:", e.input, names);
  } else console.log("OK:", e.input, "→", names.join(" | "));
}

if (failed) {
  console.error("\\n" + failed + " failed");
  process.exit(1);
}
console.log("\\nAll parse-lineup tests passed (" + (PARSE_LINEUP_FIXTURES.length + extra.length) + ")");
`,
	);

	const r = spawnSync(
		process.platform === "win32" ? "npx.cmd" : "npx",
		["--yes", "tsx", runner],
		{ cwd: root, encoding: "utf8", shell: true },
	);
	console.log(r.stdout || "");
	if (r.stderr) console.error(r.stderr);
	if (r.status !== 0) process.exit(r.status ?? 1);
}

await loadModule();
