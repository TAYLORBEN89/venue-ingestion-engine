import type { SupabaseClient } from "@supabase/supabase-js";
import {
	extractBandName,
	normalizeBandNameForMatch,
	stripVenueNameFromTitle,
} from "./parse-band-name";
import { parseLineupFromTitle, type LineupRole } from "./parse-lineup";

export type ArtistMatchStatus = "matched" | "unmatched" | "ambiguous";

export interface CatalogArtist {
	id: string;
	name: string;
	aliases: string[];
	genres: string[];
	bio: string | null;
	featured_media_id: string | null;
	social_links: Record<string, string>;
	youtube_embed: string | null;
	youtube_id: string | null;
	seo_title: string | null;
	seo_description: string | null;
	focus_keyphrase: string | null;
}

export interface ArtistMatchResult {
	extracted_band_name: string;
	matched_artist_id: string | null;
	artist_match_status: ArtistMatchStatus;
	matched_artist: CatalogArtist | null;
	match_score: number;
}

/** One lineup slot after catalog match (for multi-artist event_artists). */
export interface MatchedLineupArtist {
	fetched_name: string;
	artist_id: string | null;
	artist_name: string | null;
	artist_match_status: ArtistMatchStatus;
	match_score: number;
	billing_order: number;
	role: LineupRole;
}

function normalizeName(name: string): string {
	return normalizeBandNameForMatch(name);
}

function levenshteinRatio(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
	for (let i = 0; i < rows; i++) dist[i][0] = i;
	for (let j = 0; j < cols; j++) dist[0][j] = j;
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
		}
	}
	return 1 - dist[rows - 1][cols - 1] / Math.max(a.length, b.length);
}

/** ≥95% → auto-link artist (event still pending human publish). */
export const MATCH_THRESHOLD = 0.95;
/** 80–94% → ambiguous / admin review; below 80% → unmatched. */
export const AMBIGUOUS_THRESHOLD = 0.8;

function scoreAgainstCatalog(bandName: string, artist: CatalogArtist): number {
	const target = normalizeName(bandName);
	const names = [artist.name, ...artist.aliases].map(normalizeName).filter(Boolean);
	let best = 0;
	for (const name of names) {
		best = Math.max(best, levenshteinRatio(target, name));
		if (target === name) return 1;
	}
	return best;
}

/**
 * Match index only (id + name + aliases).
 *
 * CRITICAL: Cloudflare Workflows cap step *outputs* at 1 MiB. Returning the full
 * catalog (bios, embeds, SEO) from a step.do exceeds that (~1.8 MiB at 1.4k artists).
 * Always load this *inside* the step that uses it — never return the catalog as a
 * step result. Hydrate full rows via loadCatalogArtistsByIds after matching.
 */
export async function loadArtistCatalog(supabase: SupabaseClient, siteId: string): Promise<CatalogArtist[]> {
	// Supabase/PostgREST default max rows is 1000 — paginate for full coverage.
	const pageSize = 1000;
	const rows: CatalogArtist[] = [];
	let from = 0;
	for (;;) {
		const { data, error } = await supabase
			.from("artists")
			.select("id, name, aliases")
			.eq("site_id", siteId)
			.eq("status", "published")
			.is("deleted_at", null)
			.order("id")
			.range(from, from + pageSize - 1);

		if (error) {
			throw new Error(`Failed to load artist catalog: ${error.message}`);
		}
		if (!data?.length) break;

		for (const row of data) {
			rows.push({
				id: row.id as string,
				name: row.name as string,
				aliases: (row.aliases as string[] | null) ?? [],
				genres: [],
				bio: null,
				featured_media_id: null,
				social_links: {},
				youtube_embed: null,
				youtube_id: null,
				seo_title: null,
				seo_description: null,
				focus_keyphrase: null,
			});
		}
		if (data.length < pageSize) break;
		from += pageSize;
	}

	return rows;
}

const FULL_ARTIST_SELECT =
	"id, name, aliases, genres, bio, featured_media_id, social_links, youtube_embed, youtube_id, seo_title, seo_description, focus_keyphrase";

function rowToCatalogArtist(row: Record<string, unknown>): CatalogArtist {
	return {
		id: row.id as string,
		name: row.name as string,
		aliases: (row.aliases as string[] | null) ?? [],
		genres: (row.genres as string[] | null) ?? [],
		bio: (row.bio as string | null) ?? null,
		featured_media_id: (row.featured_media_id as string | null) ?? null,
		social_links: (row.social_links as Record<string, string>) ?? {},
		youtube_embed: (row.youtube_embed as string | null) ?? null,
		youtube_id: (row.youtube_id as string | null) ?? null,
		seo_title: (row.seo_title as string | null) ?? null,
		seo_description: (row.seo_description as string | null) ?? null,
		focus_keyphrase: (row.focus_keyphrase as string | null) ?? null,
	};
}

/** Full catalog rows for a small set of matched ids (enrichment after name match). */
export async function loadCatalogArtistsByIds(
	supabase: SupabaseClient,
	artistIds: string[],
): Promise<Map<string, CatalogArtist>> {
	const map = new Map<string, CatalogArtist>();
	const unique = [...new Set(artistIds.filter(Boolean))];
	if (unique.length === 0) return map;

	const chunkSize = 200;
	for (let i = 0; i < unique.length; i += chunkSize) {
		const chunk = unique.slice(i, i + chunkSize);
		const { data, error } = await supabase
			.from("artists")
			.select(FULL_ARTIST_SELECT)
			.in("id", chunk);
		if (error) {
			throw new Error(`Failed to hydrate artist catalog: ${error.message}`);
		}
		for (const row of data ?? []) {
			const artist = rowToCatalogArtist(row as Record<string, unknown>);
			map.set(artist.id, artist);
		}
	}
	return map;
}

/** Replace slim match hits with full catalog rows when available. */
export function hydrateArtistMatch(
	match: ArtistMatchResult,
	fullById: Map<string, CatalogArtist>,
): ArtistMatchResult {
	if (!match.matched_artist_id) return match;
	const full = fullById.get(match.matched_artist_id);
	if (!full) return match;
	return { ...match, matched_artist: full };
}

export function matchBandToCatalog(
	bandName: string,
	catalog: CatalogArtist[],
	venueName?: string | null,
): ArtistMatchResult {
	const extracted = extractBandName(bandName, venueName);
	let best: { artist: CatalogArtist; score: number } | null = null;
	let secondBest = 0;

	for (const artist of catalog) {
		const score = scoreAgainstCatalog(extracted, artist);
		if (!best || score > best.score) {
			secondBest = best?.score ?? 0;
			best = { artist, score };
		} else if (score > secondBest) {
			secondBest = score;
		}
	}

	if (!best || best.score < AMBIGUOUS_THRESHOLD) {
		return {
			extracted_band_name: extracted,
			matched_artist_id: null,
			artist_match_status: "unmatched",
			matched_artist: null,
			match_score: best?.score ?? 0,
		};
	}

	const ambiguous = secondBest >= AMBIGUOUS_THRESHOLD && best.score - secondBest < 0.05;
	if (ambiguous || best.score < MATCH_THRESHOLD) {
		return {
			extracted_band_name: extracted,
			matched_artist_id: best.artist.id,
			artist_match_status: "ambiguous",
			matched_artist: best.artist,
			match_score: best.score,
		};
	}

	return {
		extracted_band_name: extracted,
		matched_artist_id: best.artist.id,
		artist_match_status: "matched",
		matched_artist: best.artist,
		match_score: best.score,
	};
}

/**
 * Match a raw name string (already extracted) against the catalog without re-running extractBandName.
 * Used for lineup slots so "The Weary Boys" is not re-parsed as a calendar title.
 */
export function matchNameToCatalog(name: string, catalog: CatalogArtist[]): ArtistMatchResult {
	const extracted = String(name || "").trim();
	if (extracted.length < 2) {
		return {
			extracted_band_name: extracted,
			matched_artist_id: null,
			artist_match_status: "unmatched",
			matched_artist: null,
			match_score: 0,
		};
	}

	let best: { artist: CatalogArtist; score: number } | null = null;
	let secondBest = 0;

	for (const artist of catalog) {
		const score = scoreAgainstCatalog(extracted, artist);
		if (!best || score > best.score) {
			secondBest = best?.score ?? 0;
			best = { artist, score };
		} else if (score > secondBest) {
			secondBest = score;
		}
	}

	if (!best || best.score < AMBIGUOUS_THRESHOLD) {
		return {
			extracted_band_name: extracted,
			matched_artist_id: null,
			artist_match_status: "unmatched",
			matched_artist: null,
			match_score: best?.score ?? 0,
		};
	}

	const ambiguous = secondBest >= AMBIGUOUS_THRESHOLD && best.score - secondBest < 0.05;
	if (ambiguous || best.score < MATCH_THRESHOLD) {
		return {
			extracted_band_name: extracted,
			matched_artist_id: best.artist.id,
			artist_match_status: "ambiguous",
			matched_artist: best.artist,
			match_score: best.score,
		};
	}

	return {
		extracted_band_name: extracted,
		matched_artist_id: best.artist.id,
		artist_match_status: "matched",
		matched_artist: best.artist,
		match_score: best.score,
	};
}

/**
 * Parse full venue title into lineup slots and match each against the catalog.
 * Primary/headliner remains the first confident match for legacy single-artist fields.
 */
export function matchLineupToCatalog(
	rawTitle: string,
	catalog: CatalogArtist[],
	venueName?: string | null,
): { primary: ArtistMatchResult; lineup: MatchedLineupArtist[] } {
	// Strip venue suffix only — keep "w/ openers" for lineup parse
	const titleForLineup = stripVenueNameFromTitle(rawTitle.trim(), venueName);
	const slots = parseLineupFromTitle(titleForLineup);
	const lineup: MatchedLineupArtist[] = slots.map((slot) => {
		const m = matchNameToCatalog(slot.name, catalog);
		return {
			fetched_name: slot.name,
			artist_id: m.matched_artist_id,
			artist_name: m.matched_artist?.name ?? null,
			artist_match_status: m.artist_match_status,
			match_score: m.match_score,
			billing_order: slot.billing_order,
			role: slot.role,
		};
	});

	// Prefer first matched headliner; else first matched any; else single-title match
	const primaryFromLineup =
		lineup.find((l) => l.role === "headliner" && l.artist_match_status === "matched") ??
		lineup.find((l) => l.artist_match_status === "matched") ??
		lineup.find((l) => l.artist_match_status === "ambiguous") ??
		null;

	const primary = primaryFromLineup
		? matchNameToCatalog(primaryFromLineup.fetched_name, catalog)
		: matchBandToCatalog(rawTitle, catalog, venueName);

	return { primary, lineup };
}