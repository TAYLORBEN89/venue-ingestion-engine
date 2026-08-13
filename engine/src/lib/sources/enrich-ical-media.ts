import {
	extractBestEventImage,
	extractOgImage,
	extractTicketUrlFromHtml,
} from "../event-media";
import type { PartnerEvent } from "../normalize";
import { resolveTicketmasterImageFromUrl } from "../ticketmaster-images";
import { fetchPageText } from "./fetch-page";

function scoreWordPressUpload(url: string): number {
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

function extractWordPressEventImage(html: string): string | null {
	const uploads = [
		...html.matchAll(/https:\/\/[^"'\s<>]+\/wp-content\/uploads\/[^"'\s<>]+\.(?:jpe?g|png|webp)/gi),
	].map((m) => m[0]);
	if (uploads.length === 0) return null;
	return uploads.sort((a, b) => scoreWordPressUpload(b) - scoreWordPressUpload(a))[0];
}

export function extractEventPageImage(html: string): string | null {
	return extractBestEventImage(html) ?? extractOgImage(html) ?? extractWordPressEventImage(html);
}

/** Enrich iCal-derived events from their event page URL (images + Ticketmaster links). */
export async function enrichIcalEventMedia(
	events: PartnerEvent[],
	options?: {
		maxFetches?: number;
		ticketmasterApiKey?: string | null;
	},
): Promise<PartnerEvent[]> {
	const maxFetches = options?.maxFetches ?? 25;
	const enriched: PartnerEvent[] = [];
	let fetches = 0;

	for (const event of events) {
		const pageUrl = event.ticket_url ?? event.source_url;
		if (!pageUrl || !/^https?:\/\//i.test(pageUrl) || fetches >= maxFetches) {
			enriched.push(event);
			continue;
		}

		try {
			const html = await fetchPageText(pageUrl);
			fetches += 1;
			let imageUrl = extractEventPageImage(html) ?? event.image_url;
			const ticketUrl = extractTicketUrlFromHtml(html) ?? event.ticket_url;
			if (!imageUrl || !/ticketm\.net/i.test(imageUrl)) {
				const tmImage = await resolveTicketmasterImageFromUrl(
					ticketUrl,
					options?.ticketmasterApiKey,
				);
				if (tmImage) imageUrl = tmImage;
			}

			enriched.push({
				...event,
				image_url: imageUrl,
				ticket_url: ticketUrl,
				source_url: pageUrl,
			});
		} catch {
			enriched.push(event);
		}
	}

	return enriched;
}