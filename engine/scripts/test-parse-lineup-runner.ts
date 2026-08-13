
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
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nAll parse-lineup tests passed (" + (PARSE_LINEUP_FIXTURES.length + extra.length) + ")");
