import { extractYouTubeFields } from "./youtube";

export function extractOgImage(html: string): string | null {
	return (
		html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ??
		null
	);
}

export function extractTicketmasterImageUrls(html: string): string[] {
	return [
		...new Set(
			[...html.matchAll(/https?:\/\/s\d\.ticketm\.net\/[^"'\s<>]+/gi)].map((m) =>
				m[0].replace(/&amp;/g, "&"),
			),
		),
	];
}

function scoreEventImageUrl(url: string): number {
	const lower = url.toLowerCase();
	let score = 0;
	if (lower.includes("ticketm.net")) score += 100;
	if (lower.includes("event_detail_page") || lower.includes("event-detail")) score += 40;
	if (lower.includes("16_9") || lower.includes("16:9")) score += 20;
	if (lower.includes("website-files.com") && !lower.includes("logo") && !lower.includes("wordmark")) score += 10;
	if (lower.includes("wp-content/uploads") && !lower.includes("tribe-loading")) score += 30;
	if (lower.includes("wixstatic.com/media") && !lower.includes("logo")) score += 25;
	if (/\.svg(\?|$)/i.test(lower)) score -= 80;
	if (/footer|plane-20|plus-cream|wg-logo/i.test(lower)) score -= 60;
	if (/-p-\d+\./i.test(lower)) score -= 15;
	if (/\d{3,4}w[,\s]|800w|1200w/i.test(lower)) score += 20;
	if (lower.includes("logo") || lower.includes("wordmark") || lower.includes("wg-logo")) score -= 50;
	return score;
}

/** Meanwhile / Webflow event pages use a hero img.image-8 with full-size website-files art. */
export function extractWebflowEventHeroImage(html: string): string | null {
	const image8 =
		html.match(/class=["']image-8["'][^>]*src=["']([^"']+)["']/i)?.[1] ??
		html.match(/src=["']([^"']+)["'][^>]*class=["']image-8["']/i)?.[1];
	if (image8) return image8.replace(/&amp;/g, "&");

	const candidates = [
		...html.matchAll(/<img[^>]+src=["'](https:\/\/cdn\.prod\.website-files\.com[^"']+)["']/gi),
	].map((m) => m[1].replace(/&amp;/g, "&"));

	if (candidates.length === 0) return null;
	return candidates.sort((a, b) => scoreEventImageUrl(b) - scoreEventImageUrl(a))[0];
}

/** Prefer Ticketmaster CDN art, then og:image, then other non-logo images. */
export function extractBestEventImage(html: string): string | null {
	const candidates = [
		...extractTicketmasterImageUrls(html),
		extractOgImage(html),
		...[...html.matchAll(/<img[^>]+src=["'](https:\/\/cdn\.prod\.website-files\.com[^"']+)["']/gi)].map(
			(m) => m[1],
		),
	].filter((url): url is string => Boolean(url));

	if (candidates.length === 0) return null;

	return candidates.sort((a, b) => scoreEventImageUrl(b) - scoreEventImageUrl(a))[0];
}

export function extractTicketUrlFromHtml(html: string): string | null {
	return (
		html.match(/href=["'](https:\/\/www\.ticketmaster\.com\/event\/[^"']+)["']/i)?.[1] ??
		html.match(/href=["'](https:\/\/www\.prekindle\.com\/event\/[^"']+)["']/i)?.[1] ??
		html.match(/href=["'](https:\/\/[^"']*ticket[^"']*)["']/i)?.[1] ??
		null
	);
}

export function extractYouTubeFromHtml(html: string): {
	youtube_embed: string | null;
	youtube_id: string | null;
} {
	const iframeBlocks = [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0]);
	for (const block of iframeBlocks) {
		if (!/youtube|youtu\.be/i.test(block)) continue;
		const fields = extractYouTubeFields(block);
		if (fields.youtube_embed || fields.youtube_id) return fields;
	}

	const embedUrls = [
		...[...html.matchAll(/\/\/www\.youtube\.com\/embed[^"'\s]+/gi)].map((m) => `https:${m[0]}`),
		...[...html.matchAll(/https?:\/\/(?:www\.)?youtube\.com\/embed[^"'\s]+/gi)].map((m) => m[0]),
	];
	for (const url of embedUrls) {
		const fields = extractYouTubeFields(url);
		if (fields.youtube_embed || fields.youtube_id) return fields;
	}

	return { youtube_embed: null, youtube_id: null };
}