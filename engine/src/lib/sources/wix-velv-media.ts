import { extractOgImage } from "../event-media";
import { fetchPageText } from "./fetch-page";

export interface WixVelvListingEntry {
	showId: string;
	moreInfoUrl: string;
	listingImageUrl: string | null;
}

export interface WixVelvShowMedia {
	image_url: string | null;
	description: string | null;
	more_info_url: string;
}

export function resolveWixVelvListingUrl(websiteUrl: string): string | null {
	try {
		const url = new URL(websiteUrl);
		if (!/thevelveetaroom\.com$/i.test(url.hostname)) return null;
		return `${url.origin}/velv`;
	} catch {
		return null;
	}
}

/** Strip Wix resize/crop transforms; keep the canonical media asset URL. */
export function normalizeWixStaticUrl(url: string): string {
	const decoded = url.replace(/&amp;/g, "&");
	const match = decoded.match(
		/https:\/\/static\.wixstatic\.com\/media\/([^/?#]+\.(?:png|jpe?g|webp|gif|avif))/i,
	);
	return match ? `https://static.wixstatic.com/media/${match[1].replace(/%7E/gi, "~")}` : decoded;
}

function scoreWixPromoImage(url: string): number {
	const lower = url.toLowerCase();
	let score = 0;
	if (lower.includes("velveetaroom_logo") || lower.includes("logo_edited")) score -= 100;
	if (lower.includes("image-empty-state")) score += 5;
	if (/\/864884_[a-f0-9]+~mv2\.(?:png|jpe?g)/i.test(url)) score += 40;
	const size = url.match(/w_(\d+)/i)?.[1];
	if (size) score += Math.min(Number(size), 2000) / 20;
	if (lower.includes("og:image") || lower.includes("website%20square")) score += 30;
	return score;
}

export function extractWixPromoImage(html: string): string | null {
	const candidates = [
		extractOgImage(html),
		...[...html.matchAll(/https:\/\/static\.wixstatic\.com\/media\/[^"'\s<>]+/gi)].map((m) =>
			m[0].replace(/&amp;/g, "&"),
		),
	].filter((url): url is string => Boolean(url));

	if (candidates.length === 0) return null;
	const best = candidates.sort((a, b) => scoreWixPromoImage(b) - scoreWixPromoImage(a))[0];
	return normalizeWixStaticUrl(best);
}

export function extractWixVelvDescription(html: string): string | null {
	const ticketIdx = html.search(/Grab Tickets|Buy Tickets|Tickets!!!/i);
	const slice = ticketIdx > 0 ? html.slice(0, ticketIdx) : html;
	const paragraphs = [
		...slice.matchAll(/<p[^>]*class="[^"]*font_8[^"]*"[^>]*>([\s\S]*?)<\/p>/gi),
		...slice.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi),
	]
		.map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
		.filter((text) => text.length > 40 && !/doors open|ticket refund|facebook/i.test(text));

	return paragraphs[0] ?? null;
}

/** Parse Wix /velv listing: More Info + Tickets buttons tie show ids to promo pages. */
export function parseWixVelvListing(html: string): WixVelvListingEntry[] {
	const entries: WixVelvListingEntry[] = [];
	const moreInfoPattern =
		/href=["'](https:\/\/www\.thevelveetaroom\.com\/velv\/[^"']+)["'][^>]*aria-label=["']More Info["']/gi;

	for (const match of html.matchAll(moreInfoPattern)) {
		const moreInfoUrl = match[1];
		const start = match.index ?? 0;
		const after = html.slice(start, start + 2500);
		const showId =
			after.match(/seatengine\.com\/shows\/(\d+)/i)?.[1] ??
			after.match(/seatengine\.com\/events\/(\d+)/i)?.[1];
		if (!showId) continue;

		const before = html.slice(Math.max(0, start - 5000), start);
		const listingMatches = [
			...before.matchAll(/https:\/\/static\.wixstatic\.com\/media\/864884_[^"'\s<>]+/gi),
		].map((m) => m[0].replace(/&amp;/g, "&"));
		const listingImageUrl = listingMatches.at(-1) ?? null;

		entries.push({ showId, moreInfoUrl, listingImageUrl });
	}
	return entries;
}

export async function fetchWixVelvShowMedia(
	websiteUrl: string,
	showIds: Iterable<string>,
	maxDetailFetches = 25,
): Promise<Map<string, WixVelvShowMedia>> {
	const velvUrl = resolveWixVelvListingUrl(websiteUrl);
	if (!velvUrl) return new Map();

	const wanted = new Set(showIds);
	if (wanted.size === 0) return new Map();

	let listingHtml: string;
	try {
		listingHtml = await fetchPageText(velvUrl);
	} catch {
		return new Map();
	}

	const entries = parseWixVelvListing(listingHtml).filter((e) => wanted.has(e.showId));
	const byShowId = new Map<string, WixVelvShowMedia>();
	const detailCache = new Map<string, { image_url: string | null; description: string | null }>();

	const uniqueDetailUrls = [...new Set(entries.map((e) => e.moreInfoUrl))].slice(0, maxDetailFetches);

	for (const detailUrl of uniqueDetailUrls) {
		try {
			const detailHtml = await fetchPageText(detailUrl);
			detailCache.set(detailUrl, {
				image_url: extractWixPromoImage(detailHtml),
				description: extractWixVelvDescription(detailHtml),
			});
		} catch {
			detailCache.set(detailUrl, { image_url: null, description: null });
		}
	}

	for (const entry of entries) {
		const cached = detailCache.get(entry.moreInfoUrl);
		const listingImage = entry.listingImageUrl
			? normalizeWixStaticUrl(entry.listingImageUrl)
			: null;
		byShowId.set(entry.showId, {
			image_url: cached?.image_url ?? listingImage,
			description: cached?.description ?? null,
			more_info_url: entry.moreInfoUrl,
		});
	}

	return byShowId;
}