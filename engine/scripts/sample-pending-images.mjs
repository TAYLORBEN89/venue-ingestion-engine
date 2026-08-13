import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const slug = process.argv[2];
if (!slug) {
	console.error("Usage: node scripts/sample-pending-images.mjs <venue-slug>");
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
const { data: venue } = await supabase.from("venues").select("id, name").eq("slug", slug).single();
const { data: rows } = await supabase
	.from("ingested_events")
	.select("raw_title, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.limit(8);

console.log(`${venue.name}: ${rows?.length ?? 0} samples`);
for (const r of rows ?? []) {
	const img = r.raw_payload?.image_url ?? "null";
	const kind = /wixstatic/i.test(img)
		? "wix"
		: /ticketm/i.test(img)
			? "ticketmaster"
			: /headshots/i.test(img)
				? "headshot"
				: /logo|website-files/i.test(img)
					? "generic"
					: img === "null"
						? "none"
						: "other";
	console.log(`  [${kind}] ${r.raw_title}: ${img.slice(0, 90)}`);
}