import { eventFingerprint } from "./fingerprint";

export type FeedType = "auto" | "ical" | "google_calendar" | "eventbrite" | "tec_api" | "scrape";

/**
 * Decode common HTML entities in venue calendar titles/names.
 * EventON/WordPress JSON-LD often ships "Donn &amp; …" / "Murphy&#039;s …".
 */
export function decodeHtmlEntities(text: string): string {
	let s = String(text ?? "");
	// Loop so double-encoded &amp;amp; collapses
	for (let i = 0; i < 3; i++) {
		const next = s
			.replace(/&amp;/gi, "&")
			.replace(/&#0*39;|&apos;/gi, "'")
			.replace(/&#8217;|&rsquo;/gi, "'")
			.replace(/&#8216;|&lsquo;/gi, "'")
			.replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
			.replace(/&quot;/gi, '"')
			.replace(/&nbsp;/gi, " ")
			.replace(/&mdash;|&ndash;/gi, "—")
			.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
			.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
		if (next === s) break;
		s = next;
	}
	return s.replace(/\s+/g, " ").trim();
}

/** Canonical shape after any partner source is parsed. */
export interface PartnerEvent {
	title: string;
	starts_at: string;
	ends_at: string | null;
	venue_name: string;
	address: string | null;
	description: string | null;
	image_url: string | null;
	source_url: string;
	source_partner: string;
	source_event_id: string | null;
	fingerprint: string;
	raw_date_text: string;
	price_text: string | null;
	ticket_url: string | null;
	confidence: number;
	youtube_embed: string | null;
	youtube_id: string | null;
}

export function toPartnerEvent(input: {
	title: string;
	starts_at: string;
	ends_at?: string | null;
	venue_name: string;
	address?: string | null;
	description?: string | null;
	image_url?: string | null;
	source_url: string;
	source_partner: string;
	source_event_id?: string | null;
	raw_date_text?: string;
	price_text?: string | null;
	ticket_url?: string | null;
	confidence?: number;
	youtube_embed?: string | null;
	youtube_id?: string | null;
}): PartnerEvent {
	const startsAt = input.starts_at;
	const title = decodeHtmlEntities(input.title);
	const venueName = decodeHtmlEntities(input.venue_name);
	return {
		title,
		starts_at: startsAt,
		ends_at: input.ends_at ?? null,
		venue_name: venueName,
		address: input.address ?? null,
		description: input.description ? decodeHtmlEntities(input.description) : null,
		image_url: input.image_url ?? null,
		source_url: input.source_url,
		source_partner: input.source_partner,
		source_event_id: input.source_event_id ?? null,
		fingerprint: eventFingerprint(title, venueName, startsAt, input.ticket_url),
		raw_date_text: input.raw_date_text ?? startsAt,
		price_text: input.price_text ?? null,
		ticket_url: input.ticket_url ?? null,
		confidence: input.confidence ?? 1,
		youtube_embed: input.youtube_embed ?? null,
		youtube_id: input.youtube_id ?? null,
	};
}