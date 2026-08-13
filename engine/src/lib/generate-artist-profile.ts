import { generateEvergreenArtistSeo } from "./artist-seo";
import { extractYouTubeFields } from "./youtube";
import type { ArtistResearchBundle } from "./research-artist";

const CHEAP_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const STRONG_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface GeneratedArtistProfile {
	name: string;
	bio: string;
	genres: string[];
	youtube_embed: string | null;
	youtube_id: string | null;
	seo_title: string;
	seo_description: string;
	focus_keyphrase: string;
	keyphrase_synonyms: string | null;
	social_links: Record<string, string>;
}

const PROFILE_SCHEMA = {
	type: "object",
	properties: {
		bio: {
			type: "string",
			description:
				"Approximately 300 words in 2 paragraphs separated by a blank line. Fun and vivid. Do NOT mention any venue, city, or concert date. Mention the band name exactly twice.",
		},
		genres: {
			type: "array",
			items: { type: "string" },
			description: "1-3 primary music genres.",
		},
		youtube_url: {
			type: ["string", "null"],
			description: "Best official YouTube watch or embed URL for the artist, or null.",
		},
		website_url: { type: ["string", "null"] },
		instagram_url: { type: ["string", "null"] },
		spotify_url: { type: ["string", "null"] },
	},
	required: ["bio", "genres", "youtube_url", "website_url", "instagram_url", "spotify_url"],
};

interface LlmProfileFields {
	bio?: string;
	genres?: string[];
	youtube_url?: string | null;
	website_url?: string | null;
	instagram_url?: string | null;
	spotify_url?: string | null;
}

function buildPrompt(
	bandName: string,
	city: string | null | undefined,
	research: ArtistResearchBundle,
	eventHints: { imageUrl?: string | null; youtubeEmbed?: string | null },
): string {
	const researchBlock = [
		...research.bioSnippets.map((s) => `- ${s}`),
		...research.youtubeSnippets.map((s) => `- [youtube search] ${s}`),
	].join("\n");

	return `You are writing evergreen artist catalog content for a live-music events site.

Band name: ${bandName}
Market context: ${city ?? "Austin, TX"} (for genre tone only — do NOT name the city in the bio)

Web research snippets (may be incomplete or noisy — synthesize carefully, do not invent specific facts like album names unless clearly supported):
${researchBlock || "(no research snippets available)"}

Event page hints:
- scraped image available: ${eventHints.imageUrl ? "yes" : "no"}
- scraped youtube embed: ${eventHints.youtubeEmbed ? "yes" : "no"}

Write a JSON object matching the schema. The bio must be venue-neutral evergreen copy suitable for every future show listing for this artist.`;
}

function isAiQuotaError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /4006|neurons|quota|rate limit/i.test(msg);
}

async function callProfileModel(ai: CloudflareEnv["AI"], model: string, prompt: string): Promise<LlmProfileFields | null> {
	try {
		const result = await ai.run(model, {
			messages: [{ role: "user", content: prompt }],
			response_format: { type: "json_schema", json_schema: PROFILE_SCHEMA },
			max_tokens: 2048,
		});

		const raw =
			typeof result === "object" && result !== null && "response" in result
				? (result as { response: unknown }).response
				: result;

		try {
			return typeof raw === "string" ? JSON.parse(raw) : (raw as LlmProfileFields);
		} catch {
			return null;
		}
	} catch (err) {
		if (isAiQuotaError(err)) return null;
		throw err;
	}
}

function toGeneratedProfile(
	bandName: string,
	city: string | null | undefined,
	parsed: LlmProfileFields,
	youtubeEmbedHint?: string | null,
): GeneratedArtistProfile | null {
	if (!parsed.bio?.trim()) return null;

	const genres = (parsed.genres ?? []).map((g) => g.trim()).filter(Boolean).slice(0, 4);
	const seo = generateEvergreenArtistSeo({ name: bandName, bio: parsed.bio, genres, city });

	const youtubeFromScrape = extractYouTubeFields(youtubeEmbedHint);
	const youtubeFromModel = extractYouTubeFields(parsed.youtube_url);
	const youtube = youtubeFromScrape.youtube_id
		? youtubeFromScrape
		: youtubeFromModel.youtube_id
			? youtubeFromModel
			: youtubeFromScrape.youtube_embed
				? youtubeFromScrape
				: youtubeFromModel;

	const social: Record<string, string> = {};
	if (parsed.website_url) social.website = parsed.website_url;
	if (parsed.instagram_url) social.instagram = parsed.instagram_url;
	if (parsed.spotify_url) social.spotify = parsed.spotify_url;
	if (youtube.youtube_id) social.youtube = `https://www.youtube.com/watch?v=${youtube.youtube_id}`;

	const genreSynonyms = genres
		.map((g) => g.toLowerCase())
		.filter((g) => g.length > 1)
		.slice(0, 3);

	return {
		name: bandName,
		bio: parsed.bio.trim(),
		genres,
		youtube_embed: youtube.youtube_embed,
		youtube_id: youtube.youtube_id,
		seo_title: seo.seo_title,
		seo_description: seo.seo_description,
		focus_keyphrase: seo.focus_keyphrase,
		keyphrase_synonyms: genreSynonyms.length > 0 ? `live music austin, ${genreSynonyms.join(", ")}` : "live music austin",
		social_links: social,
	};
}

export async function generateArtistProfile(params: {
	ai: CloudflareEnv["AI"];
	bandName: string;
	city?: string | null;
	research: ArtistResearchBundle;
	imageUrl?: string | null;
	youtubeEmbed?: string | null;
}): Promise<GeneratedArtistProfile | null> {
	const prompt = buildPrompt(params.bandName, params.city, params.research, {
		imageUrl: params.imageUrl,
		youtubeEmbed: params.youtubeEmbed,
	});

	const cheap = await callProfileModel(params.ai, CHEAP_MODEL, prompt);
	if (cheap?.bio?.trim()) {
		const profile = toGeneratedProfile(params.bandName, params.city, cheap, params.youtubeEmbed);
		if (profile && profile.bio.length >= 120) return profile;
	}

	const strong = await callProfileModel(params.ai, STRONG_MODEL, prompt);
	if (!strong) return null;
	return toGeneratedProfile(params.bandName, params.city, strong, params.youtubeEmbed);
}