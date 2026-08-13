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
const { data: rows } = await supabase
	.from("ingested_events")
	.select("id, venues(slug, name)")
	.eq("review_status", "pending");

const byVenue = new Map();
for (const r of rows ?? []) {
	const slug = r.venues?.slug ?? "unknown";
	byVenue.set(slug, (byVenue.get(slug) ?? 0) + 1);
}
console.log("Pending by venue:");
[...byVenue.entries()]
	.sort((a, b) => b[1] - a[1])
	.forEach(([slug, n]) => console.log(`  ${n}\t${slug}`));
console.log(`\nTotal pending: ${rows?.length ?? 0}`);