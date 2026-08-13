import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devVars = readFileSync(resolve(root, ".dev.vars"), "utf8");
const env = Object.fromEntries(devVars.split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await supabase.from("venues").select("id, slug, name, calendar_url").eq("site_id", site.id).eq("slug", "stubbs-bar-b-q").maybeSingle();
const { data: source } = venue ? await supabase.from("venue_event_sources").select("id").eq("venue_id", venue.id).maybeSingle() : { data: null };
console.log(JSON.stringify({ venue, sourceId: source?.id ?? null }, null, 2));