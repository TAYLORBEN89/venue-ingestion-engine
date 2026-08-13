/**
 * Backfill image_url + youtube fields on pending ingested_events for Webflow venues.
 * Usage: node scripts/backfill-webflow-media.mjs moody-amphitheater-austin
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
	console.error("Usage: node scripts/backfill-webflow-media.mjs <venue-slug>");
	process.exit(1);
}

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function extractOgImage(html) {
	return (
		html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ??
		null
	);
}

function extractYouTubeEmbed(html) {
	for (const block of [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0])) {
		if (!/youtube/i.test(block)) continue;
		const src = block.match(/src=["']([^"']+)["']/i)?.[1];
		if (!src) continue;
		const normalized = src.startsWith("//") ? `https:${src}` : src;
		return `<iframe width="560" height="315" src="${normalized}" title="YouTube video player" frameborder="0" allowfullscreen></iframe>`;
	}
	return null;
}

function extractTicketUrl(html) {
	return (
		html.match(/href=["'](https:\/\/www\.ticketmaster\.com\/event\/[^"']+)["']/i)?.[1] ??
		html.match(/href=["'](https:\/\/www\.prekindle\.com\/event\/[^"']+)["']/i)?.[1] ??
		null
	);
}

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venues } = await supabase
	.from("venues")
	.select("id, slug, calendar_url")
	.eq("site_id", site.id)
	.in("slug", slugs);

for (const venue of venues ?? []) {
	const baseUrl = new URL(venue.calendar_url ?? "https://moodyamphitheater.com/events-tickets").origin;
	const { data: pending } = await supabase
		.from("ingested_events")
		.select("id, source_event_id, raw_payload, raw_title")
		.eq("venue_id", venue.id)
		.eq("review_status", "pending");

	console.log(`\n${venue.slug}: ${pending?.length ?? 0} pending`);
	let updated = 0;

	for (const row of pending ?? []) {
		const slug = row.source_event_id;
		if (!slug) continue;

		const pageUrl = `${baseUrl}/events/${slug}`;
		const res = await fetch(pageUrl, { headers: { "User-Agent": UA } });
		if (!res.ok) {
			console.log(`  skip ${slug}: HTTP ${res.status}`);
			continue;
		}
		const html = await res.text();
		const imageUrl = extractOgImage(html);
		const youtubeEmbed = extractYouTubeEmbed(html);
		const ticketUrl = extractTicketUrl(html);
		if (!imageUrl && !youtubeEmbed && !ticketUrl) continue;

		const payload = { ...(row.raw_payload ?? {}) };
		let changed = false;
		if (imageUrl && payload.image_url !== imageUrl) {
			payload.image_url = imageUrl;
			changed = true;
		}
		if (youtubeEmbed && payload.youtube_embed !== youtubeEmbed) {
			payload.youtube_embed = youtubeEmbed;
			changed = true;
		}
		if (ticketUrl && !payload.ticket_url) {
			payload.ticket_url = ticketUrl;
			changed = true;
		}
		if (!changed) continue;

		const { error } = await supabase.from("ingested_events").update({ raw_payload: payload }).eq("id", row.id);
		if (error) {
			console.log(`  fail ${slug}: ${error.message}`);
			continue;
		}
		updated++;
		console.log(`  ✓ ${row.raw_title}`);
		console.log(`    image: ${imageUrl ? "yes" : "no"} | youtube: ${youtubeEmbed ? "yes" : "no"}`);
	}

	console.log(`Updated ${updated} rows`);
}