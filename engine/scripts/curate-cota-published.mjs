/**
 * Post-approve COTA polish:
 * - Soft-delete Facebook day-ticket Le Mans junk (superseded by curated WEC)
 * - SportsEvent schema for motorsport
 * - Full Texas 8 Hour copy
 * - listing_url from COTA source pages where missing
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
	readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
		.split(/\r?\n/)
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const SLUG = "circuit-of-the-americas";

const { data: venue } = await sb.from("venues").select("id").eq("slug", SLUG).single();

// Soft-delete FB Le Mans admission day tickets (duplicate / low quality)
const { data: fbJunk } = await sb
	.from("events")
	.select("id, title, source")
	.eq("venue_id", venue.id)
	.eq("source", "facebook_import")
	.is("deleted_at", null)
	.ilike("title", "%Lone Star Le Mans%");

for (const e of fbJunk ?? []) {
	await sb
		.from("events")
		.update({
			status: "archived",
			deleted_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		})
		.eq("id", e.id);
	console.log("archived FB junk:", e.title);
}

const TEXAS_8 = {
	event_intro:
		"The Texas 8 Hour endurance motorcycle race hits Circuit of The Americas — eight hours of team racing under the Texas sky.",
	description: `The Texas 8 Hour is a flagship endurance motorcycle event at Circuit of The Americas, with teams racing for eight continuous hours on the full Grand Prix circuit. Expect paddock access, multi-class grids, and a full race-weekend schedule leading into the main event.

Tickets are sold via Tixr / SRO Motorsports. Plan for a long day trackside — hydration, ear protection, and early arrival recommended. This is a must-see for fans of endurance racing and MotoAmerica-adjacent series action in Austin.`,
	seo_title: "Texas 8 Hour | COTA Austin | HeyAustin",
	seo_description:
		"Texas 8 Hour endurance motorcycle racing at Circuit of The Americas, May 7–9, 2027. Tickets and weekend details.",
	focus_keyphrase: "Texas 8 Hour Austin COTA",
	schema_type: "SportsEvent",
	genres: ["Motorsports", "Racing"],
};

const { data: t8 } = await sb
	.from("events")
	.select("id")
	.eq("venue_id", venue.id)
	.eq("title", "Texas 8 Hour")
	.is("deleted_at", null)
	.maybeSingle();
if (t8) {
	await sb
		.from("events")
		.update({
			...TEXAS_8,
			listing_url: "https://www.tixr.com/groups/sro/events/texas-8-hour-196484",
			updated_at: new Date().toISOString(),
		})
		.eq("id", t8.id);
	console.log("curated Texas 8 Hour");
}

// SportsEvent + listing_url for flagship motorsport
const MOTOR = [
	{
		title: "FIA World Endurance Championship",
		listing_url: "https://circuitoftheamericas.com/event/fia-world-endurance-championship/",
	},
	{
		title: "Formula 1 United States Grand Prix",
		listing_url: "https://circuitoftheamericas.com/event/f1/",
	},
	{
		title: "MotoAmerica Superbikes",
		listing_url: "https://circuitoftheamericas.com/event/motoamericasuperbikes/",
	},
];

for (const m of MOTOR) {
	const { data: e } = await sb
		.from("events")
		.select("id")
		.eq("venue_id", venue.id)
		.eq("title", m.title)
		.is("deleted_at", null)
		.maybeSingle();
	if (!e) continue;
	await sb
		.from("events")
		.update({
			schema_type: "SportsEvent",
			listing_url: m.listing_url,
			updated_at: new Date().toISOString(),
		})
		.eq("id", e.id);
	console.log("sports schema:", m.title);
}

// Community events: SocialEvent schema
const { data: community } = await sb
	.from("events")
	.select("id, title")
	.eq("venue_id", venue.id)
	.is("deleted_at", null)
	.or("title.ilike.%Bike Night%,title.ilike.%Cars%");

for (const e of community ?? []) {
	await sb
		.from("events")
		.update({ schema_type: "SocialEvent", updated_at: new Date().toISOString() })
		.eq("id", e.id);
	console.log("social schema:", e.title);
}

const { data: final } = await sb
	.from("events")
	.select("title, starts_at, ends_at, status, source, schema_type, genres, featured_media_id, ticket_url")
	.eq("venue_id", venue.id)
	.is("deleted_at", null)
	.eq("status", "published")
	.order("starts_at");

console.log("\n=== Live published COTA calendar ===\n");
for (const e of final ?? []) {
	console.log(
		`${e.starts_at?.slice(0, 10)}  ${e.title}\n   ${e.schema_type} | ${(e.genres || []).join(", ")} | media=${!!e.featured_media_id} tix=${!!e.ticket_url} (${e.source})`,
	);
}
console.log(`\nTotal live: ${final?.length ?? 0}\n`);
