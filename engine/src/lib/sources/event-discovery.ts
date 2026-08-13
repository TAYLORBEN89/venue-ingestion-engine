import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";

export interface EventDiscoveryEvent {
	id: number;
	start: string;
	title: string;
	doors?: string;
	displayTime?: string;
	sortkey?: string;
	imageUrl?: string;
	url?: string;
}

export interface EventDiscoveryConfig {
	ajaxUrl: string;
	nonce: string;
}

export function extractEventDiscoveryConfig(html: string): EventDiscoveryConfig | null {
	// Require real Event Discovery plugin markers — bare "nonce"+"ajax_url" also appears
	// on EventON 5 and other WP plugins and must not steal the route (HTTP 400 noise).
	const isDiscoveryPlugin =
		/event-discovery|get_events_for_calendar|my_ajax_object|plugins\/event-discovery/i.test(
			html,
		);
	if (!isDiscoveryPlugin) return null;

	const nonce =
		html.match(/my_ajax_object\s*=\s*\{[^}]*"nonce"\s*:\s*"([^"]+)"/)?.[1] ??
		html.match(/"nonce"\s*:\s*"([^"]+)"/)?.[1];
	if (!nonce) return null;

	const ajaxUrlRaw =
		html.match(/my_ajax_object\s*=\s*\{[^}]*"ajax_url"\s*:\s*"([^"]+)"/)?.[1] ??
		html.match(/"ajax_url"\s*:\s*"([^"]+)"/)?.[1];

	if (!ajaxUrlRaw) return null;
	// Skip EventON 5 rest templates like /?evo-ajax=%%endpoint%%
	if (/evo-ajax|%%endpoint%%/i.test(ajaxUrlRaw)) return null;

	const ajaxUrl = ajaxUrlRaw.replace(/\\\//g, "/");
	return { ajaxUrl, nonce };
}

function decodeHtml(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractImageUrl(imageHtml: string | undefined): string | null {
	if (!imageHtml) return null;
	return imageHtml.match(/src=["']([^"']+)["']/i)?.[1] ?? null;
}

function formatDateYmd(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export async function fetchEventDiscoveryEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	config?: EventDiscoveryConfig;
}): Promise<PartnerEvent[]> {
	const config = params.config ?? extractEventDiscoveryConfig(params.calendarHtml);
	if (!config) {
		throw new Error("Event Discovery plugin config (nonce/ajax_url) not found on calendar page");
	}

	const start = new Date();
	const end = new Date(start.getTime() + params.scrapeDaysAhead * 24 * 60 * 60 * 1000);

	const body = new URLSearchParams({
		action: "get_events_for_calendar",
		nonce: config.nonce,
		start: formatDateYmd(start),
		end: formatDateYmd(end),
		params: JSON.stringify({ type: "calendar" }),
	});

	const res = await fetch(config.ajaxUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Referer: params.calendarUrl,
		},
		body,
	});

	if (!res.ok) {
		throw new Error(`Event Discovery API HTTP ${res.status} for ${config.ajaxUrl}`);
	}

	const payload = (await res.json()) as { events?: EventDiscoveryEvent[]; error?: string };
	if (payload.error) {
		throw new Error(`Event Discovery API error: ${payload.error}`);
	}

	const events = payload.events ?? [];
	return events
		.map((event) => toDiscoveryPartnerEvent(event, params))
		.filter((event): event is PartnerEvent => event !== null);
}

function toDiscoveryPartnerEvent(
	event: EventDiscoveryEvent,
	params: { calendarUrl: string; venueName: string; address: string | null; timezone: string },
): PartnerEvent | null {
	const title = decodeHtml(event.title?.trim() ?? "");
	if (!title) return null;

	const sortkey = event.sortkey?.trim();
	let startsAt: string;
	if (sortkey) {
		try {
			startsAt = localWallTimeToUtcIso(sortkey, params.timezone);
		} catch {
			return null;
		}
	} else if (event.start && event.displayTime) {
		const match = event.displayTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
		if (!match) return null;
		let hour = Number(match[1]) % 12;
		if (match[3].toUpperCase() === "PM") hour += 12;
		const minute = match[2];
		try {
			startsAt = localWallTimeToUtcIso(`${event.start} ${hour}:${minute}:00`, params.timezone);
		} catch {
			return null;
		}
	} else {
		return null;
	}

	const rawDateText = [event.start, event.doors ? `doors ${event.doors}` : null, event.displayTime ? `show ${event.displayTime}` : null]
		.filter(Boolean)
		.join(" · ");

	const imageUrl = extractImageUrl(event.imageUrl);
	const sourceUrl = event.url?.startsWith("#")
		? `${params.calendarUrl}${event.url}`
		: event.url ?? params.calendarUrl;

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		venue_name: params.venueName,
		address: params.address,
		image_url: imageUrl,
		source_url: sourceUrl,
		source_partner: "event_discovery",
		source_event_id: String(event.id),
		raw_date_text: rawDateText,
		confidence: 1,
	});
}