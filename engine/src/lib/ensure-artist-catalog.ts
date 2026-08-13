import type { SupabaseClient } from "@supabase/supabase-js";
import { generateArtistProfile } from "./generate-artist-profile";
import { normalizeBandNameForMatch } from "./parse-band-name";
import { researchArtist } from "./research-artist";
import { slugifyArtist, uploadImage } from "./upload-image";
import type { PartnerEvent } from "./normalize";

const MAX_AUTO_ARTISTS_PER_RUN = 8;

export interface EnsureArtistResult {
	artistId: string;
	bandName: string;
	created: boolean;
}

async function findExistingArtistId(
	supabase: SupabaseClient,
	siteId: string,
	bandName: string,
): Promise<string | null> {
	const norm = normalizeBandNameForMatch(bandName);
	const slug = slugifyArtist(bandName);

	const { data } = await supabase
		.from("artists")
		.select("id, name, aliases, manually_curated")
		.eq("site_id", siteId)
		.in("status", ["published", "draft"]);

	for (const row of data ?? []) {
		const names = [row.name as string, ...((row.aliases as string[] | null) ?? [])];
		for (const name of names) {
			if (normalizeBandNameForMatch(name) === norm) return row.id as string;
		}
	}

	const { data: bySlug } = await supabase
		.from("artists")
		.select("id")
		.eq("site_id", siteId)
		.eq("slug", slug)
		.maybeSingle();

	return bySlug?.id as string | null ?? null;
}

/** True when curator locked this artist (Manually Curated). */
export async function isArtistManuallyCurated(
	supabase: SupabaseClient,
	artistId: string,
): Promise<boolean> {
	const { data } = await supabase
		.from("artists")
		.select("manually_curated")
		.eq("id", artistId)
		.maybeSingle();
	return Boolean(data?.manually_curated);
}

/** True when curator locked this venue (Manually Curated). */
export async function isVenueManuallyCurated(
	supabase: SupabaseClient,
	venueId: string,
): Promise<boolean> {
	const { data } = await supabase
		.from("venues")
		.select("manually_curated")
		.eq("id", venueId)
		.maybeSingle();
	return Boolean(data?.manually_curated);
}

export interface CreateArtistFromResearchParams {
	supabase: SupabaseClient;
	browser: CloudflareEnv["BROWSER"];
	ai: CloudflareEnv["AI"];
	siteId: string;
	bandName: string;
	city?: string | null;
	imageUrl?: string | null;
	youtubeEmbed?: string | null;
}

/** Research, generate profile fields, and insert a published artist row. */
export async function createArtistFromResearch(
	params: CreateArtistFromResearchParams,
): Promise<EnsureArtistResult | null> {
	const existingId = await findExistingArtistId(params.supabase, params.siteId, params.bandName);
	if (existingId) {
		return { artistId: existingId, bandName: params.bandName, created: false };
	}

	let researchSnippets: string[] = [];
	try {
		const research = await researchArtist(params.browser, params.bandName, params.city);
		researchSnippets = [...research.bioSnippets, ...research.youtubeSnippets];
	} catch {
		// Browser research is best-effort when quota or rate limits hit.
	}

	const generated = await generateArtistProfile({
		ai: params.ai,
		bandName: params.bandName,
		city: params.city,
		research: { bioSnippets: researchSnippets, youtubeSnippets: [] },
		imageUrl: params.imageUrl,
		youtubeEmbed: params.youtubeEmbed,
	}).catch(() => null);

	const researchHint =
		researchSnippets.find((s) => s.length > 40)?.slice(0, 280) ??
		`${params.bandName} is a live music act performing in the ${params.city ?? "Austin"} area.`;

	const profile = generated ?? {
		name: params.bandName,
		bio: `${params.bandName} brings live music to ${params.city ?? "Austin"}. ${researchHint}`,
		genres: [],
		youtube_embed: params.youtubeEmbed ?? null,
		youtube_id: null,
		seo_title: params.bandName,
		seo_description: `${params.bandName} — live music in ${params.city ?? "Austin"}.`,
		focus_keyphrase: params.bandName,
		keyphrase_synonyms: "live music austin",
		social_links: {},
	};

	let featuredMediaId: string | null = null;
	if (params.imageUrl) {
		featuredMediaId = await uploadImage(params.supabase, params.siteId, params.bandName, params.imageUrl);
	}

	let slug = slugifyArtist(params.bandName);
	for (let attempt = 0; attempt < 3; attempt++) {
		const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
		const { data: slugHit } = await params.supabase
			.from("artists")
			.select("id")
			.eq("site_id", params.siteId)
			.eq("slug", candidate)
			.maybeSingle();
		if (!slugHit) {
			slug = candidate;
			break;
		}
	}

	const { data, error } = await params.supabase
		.from("artists")
		.insert({
			site_id: params.siteId,
			slug,
			name: profile.name,
			bio: profile.bio,
			genres: profile.genres,
			youtube_embed: profile.youtube_embed,
			youtube_id: profile.youtube_id,
			seo_title: profile.seo_title,
			seo_description: profile.seo_description,
			focus_keyphrase: profile.focus_keyphrase,
			keyphrase_synonyms: profile.keyphrase_synonyms,
			social_links: profile.social_links,
			featured_media_id: featuredMediaId,
			status: "published",
			updated_at: new Date().toISOString(),
		})
		.select("id")
		.single();

	if (error || !data) {
		console.error(`Failed to create artist ${params.bandName}: ${error?.message ?? "unknown"}`);
		return null;
	}

	return { artistId: data.id as string, bandName: params.bandName, created: true };
}

interface UnmatchedBandContext {
	bandName: string;
	imageUrl: string | null;
	youtubeEmbed: string | null;
}

function collectUnmatchedBands(events: PartnerEvent[], getBandName: (title: string) => string): UnmatchedBandContext[] {
	const byNorm = new Map<string, UnmatchedBandContext>();

	for (const event of events) {
		const bandName = getBandName(event.title);
		if (!bandName || bandName.length < 2) continue;
		const norm = normalizeBandNameForMatch(bandName);
		if (!norm) continue;

		const existing = byNorm.get(norm);
		if (!existing) {
			byNorm.set(norm, {
				bandName,
				imageUrl: event.image_url,
				youtubeEmbed: event.youtube_embed,
			});
			continue;
		}

		if (!existing.imageUrl && event.image_url) existing.imageUrl = event.image_url;
		if (!existing.youtubeEmbed && event.youtube_embed) existing.youtubeEmbed = event.youtube_embed;
	}

	return [...byNorm.values()];
}

/** Create researched artist profiles for bands missing from the catalog (deduped per run). */
export async function ensureArtistsForUnmatchedEvents(params: {
	supabase: SupabaseClient;
	browser: CloudflareEnv["BROWSER"];
	ai: CloudflareEnv["AI"];
	siteId: string;
	city?: string | null;
	events: PartnerEvent[];
	isUnmatched: (event: PartnerEvent) => boolean;
	getBandName: (title: string) => string;
}): Promise<EnsureArtistResult[]> {
	const unmatchedEvents = params.events.filter(params.isUnmatched);
	const bands = collectUnmatchedBands(unmatchedEvents, params.getBandName).slice(0, MAX_AUTO_ARTISTS_PER_RUN);

	const results: EnsureArtistResult[] = [];
	for (const band of bands) {
		const result = await createArtistFromResearch({
			supabase: params.supabase,
			browser: params.browser,
			ai: params.ai,
			siteId: params.siteId,
			bandName: band.bandName,
			city: params.city,
			imageUrl: band.imageUrl,
			youtubeEmbed: band.youtubeEmbed,
		});
		if (result) results.push(result);
	}

	return results;
}