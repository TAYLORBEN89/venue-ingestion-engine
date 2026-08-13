/**
 * Backfill image_url on pending ingested_events from event detail pages.
 * Usage: node scripts/backfill-pending-images.mjs [venue-slug...]
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
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function scoreWordPressUpload(url) {
	const lower = url.toLowerCase();
	let score = 0;
	if (/tribe-loading|favicon|icon-|logo|moody\.center_vsimple|static_outdoor-concertvision/i.test(lower)) {
		score -= 100;
	}
	if (/\d{3,4}x\d{3,4}/.test(lower)) score += 50;
	if (/1920x1080|1260x596|1200x|1080x/.test(lower)) score += 30;
	if (/\/uploads\/20\d{2}\/\d{2}\//.test(lower)) score += 20;
	return score;
}

function extractEventPageImage(html) {
	const og =
		html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
	if (og && scoreWordPressUpload(og) > -50) return og;

	const uploads = [
		...html.matchAll(/https:\/\/[^"'\s<>]+\/wp-content\/uploads\/[^"'\s<>]+\.(?:jpe?g|png|webp)/gi),
	].map((m) => m[0]);
	if (uploads.length === 0) return null;
	return uploads.sort((a, b) => scoreWordPressUpload(b) - scoreWordPressUpload(a))[0];
}

function moodyEventPageUrl(ticketUrl) {
	if (!ticketUrl) return null;
	if (/moodycenteratx\.com\/event\//i.test(ticketUrl)) return ticketUrl;
	return null;
}

let venueFilter = slugs;
if (venueFilter.length === 0) {
	const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
	const { data: venues } = await supabase.from("venues").select("slug").eq("site_id", site.id);
	venueFilter = (venues ?? []).map((v) => v.slug);
}

let updated = 0;
let skipped = 0;
let failed = 0;

for (const slug of venueFilter) {
	const { data: venue } = await supabase.from("venues").select("id, name, slug").eq("slug", slug).single();
	if (!venue) {
		console.error(`Venue not found: ${slug}`);
		continue;
	}

	const { data: pending } = await supabase
		.from("ingested_events")
		.select("id, raw_title, raw_payload")
		.eq("venue_id", venue.id)
		.eq("review_status", "pending");

	const needsImage = (pending ?? []).filter((row) => !row.raw_payload?.image_url);
	console.log(`\n${venue.name}: ${needsImage.length}/${pending?.length ?? 0} pending without images`);

	for (const row of needsImage) {
		const payload = row.raw_payload ?? {};
		const pageUrl = moodyEventPageUrl(payload.ticket_url) ?? payload.source_url ?? payload.ticket_url;
		if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
			console.log(`  SKIP ${row.raw_title}: no detail page URL`);
			skipped++;
			continue;
		}

		try {
			const html = await (await fetch(pageUrl, { headers: { "User-Agent": UA } })).text();
			const imageUrl = extractEventPageImage(html);
			if (!imageUrl) {
				console.log(`  FAIL ${row.raw_title}: no image on ${pageUrl}`);
				failed++;
				continue;
			}

			const nextPayload = { ...payload, image_url: imageUrl };
			const { error } = await supabase
				.from("ingested_events")
				.update({ raw_payload: nextPayload })
				.eq("id", row.id);
			if (error) {
				console.log(`  FAIL ${row.raw_title}: ${error.message}`);
				failed++;
				continue;
			}

			console.log(`  ✓ ${row.raw_title}: ${imageUrl.split("/").pop()}`);
			updated++;
		} catch (err) {
			console.log(`  FAIL ${row.raw_title}: ${err.message}`);
			failed++;
		}
	}
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped, ${failed} failed`);