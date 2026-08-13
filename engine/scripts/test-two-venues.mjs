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
const WORKER = "https://events-platform-ingestion.ben-745.workers.dev";
const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();

for (const slug of ["hotel-vegas", "meanwhile-brewing-company"]) {
	const { data: v } = await supabase
		.from("venues")
		.select("name, calendar_url, address")
		.eq("site_id", site.id)
		.eq("slug", slug)
		.single();
	const res = await fetch(`${WORKER}/test-source`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			calendarUrl: v.calendar_url,
			venueName: v.name,
			venueAddress: v.address,
			scrapeDaysAhead: 90,
		}),
	});
	const data = await res.json();
	console.log(`\n${v.name}`);
	console.log(`  platform: ${data.detected_platform} ready: ${data.ready} events: ${data.events_found}`);
	console.log(`  ${data.messages?.[0]}`);
	console.log(`  samples: ${data.sample_titles?.slice(0, 6)?.join("; ")}`);
}