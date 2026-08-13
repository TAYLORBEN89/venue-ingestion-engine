/**
 * Bulk-approve pending ingested_events for venue slugs (same logic as admin approveAllForVenue).
 *
 * POLICY: AI ingestion is never auto-approved. This script is a *manual* bulk tool only.
 * It refuses to run unless you pass --confirm-bulk-approve so agents / pilot scripts
 * cannot silently publish.
 *
 * Usage:
 *   node scripts/approve-pending.mjs --confirm-bulk-approve the-mohawk
 *   node scripts/approve-pending.mjs --confirm-bulk-approve --all --new-only
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { isApprovalMetadataComplete } from "./lib/classify-event-metadata.mjs";
import { resolveIngestedMetadata } from "./lib/resolve-ingested-metadata.mjs";
import { isCompletedPilotSlug } from "./lib/pilot-venue-filters.mjs";

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
const INGESTION_WORKER = process.env.INGESTION_WORKER_URL ?? "https://events-platform-ingestion.ben-745.workers.dev";
const args = process.argv.slice(2);
const posterOnly = args.includes("--poster-only");
const withImagesOnly = args.includes("--with-images");
const withMetadataOnly = args.includes("--with-metadata");
const newOnly = args.includes("--new-only");
const approveAll = args.includes("--all");
const confirmed = args.includes("--confirm-bulk-approve");
const slugs = args.filter((a) => !a.startsWith("--"));
const GENERIC_IMAGE_RE = /Static_Outdoor-ConcertVision|Moody\.Center_vSimple/i;

if (!confirmed) {
	console.error(
		"REFUSED: AI ingestion is never auto-approved.\n" +
			"This bulk script will publish events without UI review.\n" +
			"Approve one-by-one in admin /ingestion, or re-run with explicit:\n" +
			"  --confirm-bulk-approve\n",
	);
	process.exit(2);
}

if (slugs.length === 0 && !approveAll) {
	console.error(
		"Usage: node scripts/approve-pending.mjs --confirm-bulk-approve <venue-slug> [...] [--poster-only] [--with-images] [--with-metadata]\n" +
			"   or: node scripts/approve-pending.mjs --confirm-bulk-approve --all [--with-images] [--with-metadata] [--new-only]",
	);
	process.exit(1);
}

function slugify(text) {
	return text
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 80);
}

/** Date+time slug so recurring same-title events don't collide (Friends Blues Jam). */
function eventSlug(title, startsAtIso, timeZone = "America/Chicago") {
	const at = new Date(startsAtIso);
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		})
			.formatToParts(at)
			.filter((p) => p.type !== "literal")
			.map((p) => [p.type, p.value]),
	);
	let hour = parts.hour ?? "00";
	if (hour === "24") hour = "00";
	const stamp = `${parts.year}-${parts.month}-${parts.day}-${hour}${parts.minute ?? "00"}`;
	const base = slugify(title).slice(0, 60) || "event";
	return `${base}-${stamp}`;
}

function truncate(text, maxLen) {
	if (text.length <= maxLen) return text;
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLen - 1)}…`;
}

function formatDate(iso) {
	return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function generateEventSeo({ title, venueName, city, brandName, startsAt, priceText }) {
	const focus_keyphrase = `${title} ${city}`.trim();
	const seo_title = truncate(`${title} | ${venueName} ${city} | ${brandName}`, 60);
	const dateStr = formatDate(startsAt);
	const priceSuffix = priceText ? ` ${priceText}.` : "";
	const seo_description = truncate(`${title} live at ${venueName} in ${city} on ${dateStr}.${priceSuffix}`, 156);
	return { focus_keyphrase, seo_title, seo_description };
}

async function uploadImage(siteId, altText, imageUrl) {
	try {
		const response = await fetch(imageUrl);
		if (!response.ok) return null;
		const contentType = response.headers.get("content-type") ?? "image/jpeg";
		const ext = contentType.split("/")[1]?.split(";")[0] ?? "jpg";
		const bytes = await response.arrayBuffer();
		const path = `${siteId}/${crypto.randomUUID()}.${ext}`;
		const { error: uploadError } = await supabase.storage
			.from("event-media")
			.upload(path, bytes, { contentType, upsert: false });
		if (uploadError) return null;
		const {
			data: { publicUrl },
		} = supabase.storage.from("event-media").getPublicUrl(path);
		const { data: mediaRow, error: mediaError } = await supabase
			.from("media")
			.insert({ site_id: siteId, storage_path: publicUrl, alt_text: altText })
			.select("id")
			.single();
		if (mediaError || !mediaRow) return null;
		return mediaRow.id;
	} catch {
		return null;
	}
}

async function linkEventArtist(eventId, artistId) {
	await supabase.from("event_artists").upsert({ event_id: eventId, artist_id: artistId }, { onConflict: "event_id,artist_id" });
}

async function linkEventCategory(eventId, categoryId) {
	await supabase
		.from("event_categories")
		.upsert({ event_id: eventId, category_id: categoryId }, { onConflict: "event_id,category_id" });
}

async function backfillArtistMedia(artistId, payload, mediaId) {
	const { data: artist } = await supabase
		.from("artists")
		.select("featured_media_id, youtube_embed, youtube_id")
		.eq("id", artistId)
		.single();
	if (!artist) return;

	const updates = {};
	if (!artist.featured_media_id && (payload.artist_media_id || mediaId)) {
		updates.featured_media_id = payload.artist_media_id ?? mediaId;
	}
	if (!artist.youtube_embed && payload.youtube_embed) updates.youtube_embed = payload.youtube_embed;
	if (!artist.youtube_id && payload.youtube_id) updates.youtube_id = payload.youtube_id;
	if (Object.keys(updates).length === 0) return;

	updates.updated_at = new Date().toISOString();
	await supabase.from("artists").update(updates).eq("id", artistId);
}

async function resolveSeo(ingested, payload) {
	const siteCity = ingested.venue?.sites?.city ?? null;
	if (ingested.matched_artist_id) {
		const { data: artist } = await supabase
			.from("artists")
			.select("name, seo_title, seo_description, focus_keyphrase")
			.eq("id", ingested.matched_artist_id)
			.single();
		if (artist?.seo_title && artist?.seo_description) {
			return {
				seo_title: artist.seo_title,
				seo_description: artist.seo_description,
				focus_keyphrase: artist.focus_keyphrase ?? null,
			};
		}
	}
	if (payload.seo_title && payload.seo_description) {
		return {
			seo_title: payload.seo_title,
			seo_description: payload.seo_description,
			focus_keyphrase: payload.focus_keyphrase ?? null,
		};
	}
	if (ingested.venue?.sites && ingested.parsed_starts_at) {
		return generateEventSeo({
			title: ingested.raw_title,
			venueName: ingested.venue.name,
			city: ingested.venue.sites.city,
			brandName: ingested.venue.sites.name,
			startsAt: ingested.parsed_starts_at,
			priceText: payload.price_text,
		});
	}
	return null;
}

async function ensureArtistForIngested(row, payload) {
	// Generate only when unmatched
	if (!row.matched_artist_id && row.extracted_band_name && row.venue) {
		const res = await fetch(`${INGESTION_WORKER}/generate-artist`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				siteId: row.venue.site_id,
				bandName: row.extracted_band_name,
				city: row.venue.sites?.city ?? null,
				imageUrl: payload.image_url ?? null,
				youtubeEmbed: payload.youtube_embed ?? null,
			}),
		});

		if (!res.ok) {
			console.warn(`generate-artist failed for ${row.extracted_band_name}: ${res.status}`);
		} else {
			const generated = await res.json();
			if (generated?.artistId) {
				await supabase
					.from("ingested_events")
					.update({
						matched_artist_id: generated.artistId,
						artist_match_status: "matched",
					})
					.eq("id", row.id);
				row = {
					...row,
					matched_artist_id: generated.artistId,
					artist_match_status: "matched",
				};
			}
		}
	}

	// Always load catalog artist media when matched (pre-curated artists too).
	if (row.matched_artist_id) {
		const { data: artist } = await supabase
			.from("artists")
			.select(
				"name, featured_media_id, youtube_embed, youtube_id, genres, seo_title, seo_description, focus_keyphrase",
			)
			.eq("id", row.matched_artist_id)
			.single();

		if (artist) {
			payload.artist_media_id =
				artist.featured_media_id ?? payload.artist_media_id ?? null;
			payload.youtube_embed = artist.youtube_embed ?? payload.youtube_embed ?? null;
			payload.youtube_id = artist.youtube_id ?? payload.youtube_id ?? null;
			if (!payload.genres?.length && artist.genres?.length) {
				payload.genres = artist.genres;
			}
			payload.seo_title = artist.seo_title ?? payload.seo_title ?? null;
			payload.seo_description =
				artist.seo_description ?? payload.seo_description ?? null;
			payload.focus_keyphrase =
				artist.focus_keyphrase ?? payload.focus_keyphrase ?? null;
		}
	}

	// Do NOT rewrite raw_title / public title to artist name
	return row;
}

async function approveOne(id) {
	let { data, error: fetchError } = await supabase
		.from("ingested_events")
		.select(
			"id, raw_title, parsed_starts_at, parsed_ends_at, matched_event_id, source_event_id, fingerprint, matched_artist_id, extracted_band_name, artist_match_status, raw_payload, venue:venues(id, site_id, name, description, sites(name, city))",
		)
		.eq("id", id)
		.single();

	if (fetchError || !data) return `not found: ${fetchError?.message}`;

	let payload = data.raw_payload ?? {};
	data = await ensureArtistForIngested(data, payload);
	payload = await resolveIngestedMetadata(supabase, data, payload);

	const metadataCheck = isApprovalMetadataComplete(payload);
	if (!metadataCheck.ok) {
		return `missing metadata: ${metadataCheck.missing.join(", ")}`;
	}

	// Curated artist photo first; venue poster only if artist has no media.
	let mediaId = payload.artist_media_id ?? null;
	if (!mediaId && payload.image_url && data.venue) {
		mediaId = await uploadImage(data.venue.site_id, data.raw_title, payload.image_url);
	}

	const seo = await resolveSeo(data, payload);
	const usesLayeredContent = Boolean(data.matched_artist_id);

	if (data.matched_event_id) {
		const updates = {
			title: data.raw_title,
			updated_at: new Date().toISOString(),
		};
		if (data.parsed_starts_at) updates.starts_at = data.parsed_starts_at;
		if (data.parsed_ends_at) updates.ends_at = data.parsed_ends_at;
		if (usesLayeredContent) updates.description = null;
		else if (payload.description) updates.description = payload.description;
		if (payload.event_intro) updates.event_intro = payload.event_intro;
		if (payload.ticket_url) updates.ticket_url = payload.ticket_url;
		if (payload.price_text) updates.price_text = payload.price_text;
		if (mediaId) updates.featured_media_id = mediaId;
		if (data.source_event_id) updates.source_event_id = data.source_event_id;
		if (data.fingerprint) updates.fingerprint = data.fingerprint;
		if (seo) {
			updates.seo_title = seo.seo_title;
			updates.seo_description = seo.seo_description;
			updates.focus_keyphrase = seo.focus_keyphrase;
		}
		if (payload.youtube_embed) updates.youtube_embed = payload.youtube_embed;
		if (payload.youtube_id) updates.youtube_id = payload.youtube_id;
		if (payload.genres?.length) updates.genres = payload.genres;
		if (payload.category_slug) {
			const map = {
				"live-music": "MusicEvent",
				comedy: "ComedyEvent",
				festivals: "Festival",
				"food-drink": "FoodEvent",
				"happy-hour": "Event",
				family: "Event",
				outdoors: "Event",
			};
			updates.schema_type = map[payload.category_slug] || "Event";
		}
		const { error } = await supabase.from("events").update(updates).eq("id", data.matched_event_id);
		if (error) return `update failed: ${error.message}`;
		if (payload.category_id) {
			await linkEventCategory(data.matched_event_id, payload.category_id);
		}
		if (data.matched_artist_id) {
			await linkEventArtist(data.matched_event_id, data.matched_artist_id);
			await backfillArtistMedia(data.matched_artist_id, payload, mediaId);
		}
	} else {
		if (!data.parsed_starts_at) return "no parsed start date";
		if (!data.venue) return "no venue";

		// Venue-fetched title only — never replace with catalog artist name
		const eventTitle =
			(typeof payload.original_title === "string" && payload.original_title.trim()) ||
			(typeof payload.fetched_event_title === "string" && payload.fetched_event_title.trim()) ||
			data.raw_title;

		const eventIntro = payload.event_intro ?? null;
		// Time-inclusive slug — avoids unique collisions for recurring same-title shows
		let slug = eventSlug(eventTitle, data.parsed_starts_at);
		const source = payload.import_method === "ai_scrape" ? "ai_ingested" : "partner_import";

		const eventUpdates = {
			title: eventTitle,
			description: usesLayeredContent ? null : (payload.description ?? null),
			event_intro: eventIntro,
			starts_at: data.parsed_starts_at,
			ends_at: data.parsed_ends_at,
			ticket_url: payload.ticket_url ?? null,
			price_text: payload.price_text ?? null,
			featured_media_id: mediaId,
			source_event_id: data.source_event_id,
			fingerprint: data.fingerprint,
			ingested_event_id: data.id,
			status: "published",
			updated_at: new Date().toISOString(),
			seo_title: seo?.seo_title ?? null,
			seo_description: seo?.seo_description ?? null,
			focus_keyphrase: seo?.focus_keyphrase ?? null,
			youtube_embed: payload.youtube_embed ?? null,
			youtube_id: payload.youtube_id ?? null,
			genres: payload.genres ?? [],
			schema_type: (() => {
				const map = {
					"live-music": "MusicEvent",
					comedy: "ComedyEvent",
					festivals: "Festival",
					"food-drink": "FoodEvent",
					"happy-hour": "Event",
					family: "Event",
					outdoors: "Event",
				};
				return map[payload.category_slug] || "Event";
			})(),
		};

		// Prefer match by source_event_id / fingerprint over slug so re-approve updates the right row
		let eventId = null;
		if (data.source_event_id) {
			const { data: bySource } = await supabase
				.from("events")
				.select("id")
				.eq("venue_id", data.venue.id)
				.eq("source_event_id", data.source_event_id)
				.maybeSingle();
			eventId = bySource?.id ?? null;
		}
		if (!eventId && data.fingerprint) {
			const { data: byFp } = await supabase
				.from("events")
				.select("id")
				.eq("venue_id", data.venue.id)
				.eq("fingerprint", data.fingerprint)
				.maybeSingle();
			eventId = byFp?.id ?? null;
		}
		if (!eventId) {
			const { data: existing } = await supabase
				.from("events")
				.select("id")
				.eq("site_id", data.venue.site_id)
				.eq("slug", slug)
				.maybeSingle();
			// Only reuse slug match if starts_at is the same event (not a different time same day)
			if (existing?.id) {
				const { data: row } = await supabase
					.from("events")
					.select("id, starts_at")
					.eq("id", existing.id)
					.single();
				if (row && Math.abs(+new Date(row.starts_at) - +new Date(data.parsed_starts_at)) < 60_000) {
					eventId = row.id;
				}
			}
		}

		if (eventId) {
			const { error } = await supabase.from("events").update(eventUpdates).eq("id", eventId);
			if (error) return `update existing failed: ${error.message}`;
		} else {
			let created = null;
			let lastErr = null;
			for (let attempt = 0; attempt < 5; attempt++) {
				const trySlug = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
				const { data: row, error } = await supabase
					.from("events")
					.insert({
						site_id: data.venue.site_id,
						venue_id: data.venue.id,
						slug: trySlug,
						// Publish on approve so public venue pages show events immediately
						status: "published",
						source,
						...eventUpdates,
					})
					.select("id")
					.single();
				if (!error && row) {
					created = row;
					slug = trySlug;
					lastErr = null;
					break;
				}
				lastErr = error?.message ?? "create failed";
				if (!/duplicate|unique/i.test(lastErr)) break;
			}
			if (!created) return `create failed: ${lastErr}`;
			eventId = created.id;
		}

		if (payload.category_id && eventId) {
			await linkEventCategory(eventId, payload.category_id);
		}
		if (data.matched_artist_id && eventId) {
			await linkEventArtist(eventId, data.matched_artist_id);
			await backfillArtistMedia(data.matched_artist_id, payload, mediaId);
		}
	}

	const { error: reviewError } = await supabase
		.from("ingested_events")
		.update({ review_status: "approved", reviewed_at: new Date().toISOString() })
		.eq("id", id);
	if (reviewError) return `approve mark failed: ${reviewError.message}`;
	return null;
}

const { data: site } = await supabase.from("sites").select("id").eq("slug", "heyaustin").single();
let venueQuery = supabase.from("venues").select("id, slug, name").eq("site_id", site.id);
if (!approveAll) venueQuery = venueQuery.in("slug", slugs);
let { data: venues } = await venueQuery;

if (newOnly) {
	const before = venues?.length ?? 0;
	venues = (venues ?? []).filter((v) => !isCompletedPilotSlug(v.slug));
	console.log(`--new-only: ${venues.length} venues (skipped ${before - venues.length} completed pilots)`);
}

let totalApproved = 0;
let totalSkipped = 0;

for (const venue of venues ?? []) {
	const { data: pending } = await supabase
		.from("ingested_events")
		.select("id, raw_title, raw_payload")
		.eq("venue_id", venue.id)
		.eq("review_status", "pending");

	const eligible = (pending ?? []).filter((row) => {
		const img = row.raw_payload?.image_url;
		const payload = row.raw_payload ?? {};
		const metadata = isApprovalMetadataComplete(payload);
		if (posterOnly) return Boolean(img) && !GENERIC_IMAGE_RE.test(img) && metadata.ok;
		if (withMetadataOnly) return metadata.ok;
		if (withImagesOnly) return Boolean(img) && metadata.ok;
		return true;
	});

	const filterNote = posterOnly
		? ` (${eligible.length} with posters + metadata)`
		: withMetadataOnly
			? ` (${eligible.length} with genres + category)`
			: withImagesOnly
				? ` (${eligible.length} with images + metadata)`
				: "";
	console.log(`\n${venue.name} (${venue.slug}): ${pending?.length ?? 0} pending${filterNote}`);
	for (const row of eligible) {
		const err = await approveOne(row.id);
		if (err) {
			console.log(`  SKIP ${row.raw_title}: ${err}`);
			totalSkipped++;
		} else {
			console.log(`  ✓ ${row.raw_title}`);
			totalApproved++;
		}
	}
}

if (!approveAll) {
	const missing = slugs.filter((s) => !(venues ?? []).some((v) => v.slug === s));
	if (missing.length) console.log("\nMissing venues:", missing.join(", "));
}

console.log(`\nDone: ${totalApproved} approved, ${totalSkipped} skipped`);