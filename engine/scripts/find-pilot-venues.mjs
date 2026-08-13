import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devVars = readFileSync(resolve(root, ".dev.vars"), "utf8");
const env = Object.fromEntries(devVars.split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();

for (const q of ["hotel", "mohawk", "moody", "vegas", "amphitheater"]) {
	const { data } = await supabase.from("venues").select("slug, name, calendar_url").eq("site_id", site.id).or(`name.ilike.%${q}%,slug.ilike.%${q}%`).limit(5);
	if (data?.length) {
		console.log(`\n${q}:`);
		for (const v of data) console.log(`  ${v.slug} | ${v.calendar_url ?? "(no calendar)"}`);
	}
}