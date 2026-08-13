/**
 * Bulk-reject pending ingested_events for venue slugs.
 * Usage: node scripts/reject-pending.mjs the-velveeta-room
 */
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
const slugs = process.argv.slice(2);
if (slugs.length === 0) {
	console.error("Usage: node scripts/reject-pending.mjs <venue-slug> [venue-slug...]");
	process.exit(1);
}

for (const slug of slugs) {
	const { data: venue, error: venueError } = await supabase
		.from("venues")
		.select("id, name, slug")
		.eq("slug", slug)
		.single();
	if (venueError || !venue) {
		console.error(`Venue not found: ${slug}`);
		continue;
	}

	const { data: pending, error: pendingError } = await supabase
		.from("ingested_events")
		.select("id, raw_title")
		.eq("venue_id", venue.id)
		.eq("review_status", "pending");
	if (pendingError) {
		console.error(`Failed to list pending for ${slug}:`, pendingError.message);
		continue;
	}
	if (!pending?.length) {
		console.log(`${venue.name}: no pending rows`);
		continue;
	}

	const ids = pending.map((r) => r.id);
	const { error: updateError } = await supabase
		.from("ingested_events")
		.update({ review_status: "rejected", reviewed_at: new Date().toISOString() })
		.in("id", ids);
	if (updateError) {
		console.error(`Failed to reject ${slug}:`, updateError.message);
		continue;
	}

	console.log(`${venue.name}: rejected ${ids.length} pending events`);
	for (const row of pending) {
		console.log(`  - ${row.raw_title}`);
	}
}