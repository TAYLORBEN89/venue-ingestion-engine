/**
 * LiveNation / Ticketmaster venue sites (Scoot Inn, Emo's, etc.).
 *
 * Homepage often embeds schema.org MusicEvent JSON-LD for every show.
 * /events is a thin client shell — prefer homepage or any page with ld+json.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { renderPageContent } from "../browser";
import { localWallTimeToUtcIso } from "./local-time";

async function fetchLight(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 events-platform-livenation",
			Accept: "text/html,*/*",
		},
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.text();
}

export function isLiveNationSite(html: string, pageUrl: string): boolean {
	const haystack = `${pageUrl}\n${html}`.toLowerCase();
	return (
		/livenation|ticketmaster\.com|livenationcdn/i.test(haystack) ||
		/scootinnaustin\.com|emosaustin\.com/i.test(pageUrl)
	);
}

function stripHtml(value: string): string {
	return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseSchemaDate(startDate: string, timezone: string): string {
	// "2026-08-07T18:00:00" wall time at venue, or with offset / Z
	if (/Z$|[+-]\d{2}:\d{2}$/.test(startDate)) {
		const d = new Date(startDate);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	const m = startDate.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
	if (m) {
		const wall = `${m[1]} ${m[2]}:${m[3] ?? "00"}`;
		return localWallTimeToUtcIso(wall, timezone);
	}
	const d = new Date(startDate);
	if (Number.isNaN(d.getTime())) throw new Error(`bad date ${startDate}`);
	return d.toISOString();
}

interface SchemaEvent {
	"@type"?: string;
	name?: string;
	description?: string;
	image?: string | string[] | { url?: string };
	startDate?: string;
	endDate?: string;
	url?: string;
	offers?: { url?: string; price?: string | number; priceCurrency?: string } | Array<{ url?: string }>;
}

function imageUrl(image: SchemaEvent["image"]): string | null {
	if (!image) return null;
	if (typeof image === "string") return image;
	if (Array.isArray(image)) return typeof image[0] === "string" ? image[0] : null;
	return image.url ?? null;
}

function offerUrl(offers: SchemaEvent["offers"]): string | null {
	if (!offers) return null;
	if (Array.isArray(offers)) return offers[0]?.url ?? null;
	return offers.url ?? null;
}

function offerPrice(offers: SchemaEvent["offers"]): string | null {
	if (!offers || Array.isArray(offers)) return null;
	if (offers.price === undefined || offers.price === null || offers.price === "") return null;
	const p = String(offers.price);
	return p.startsWith("$") ? p : `$${p}`;
}

export function parseLiveNationJsonLd(
	html: string,
	venueName: string,
	address: string | null,
	timezone: string,
): PartnerEvent[] {
	const events: PartnerEvent[] = [];
	const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

	for (const block of blocks) {
		try {
			const raw = JSON.parse(block[1]) as SchemaEvent | SchemaEvent[] | { "@graph"?: SchemaEvent[] };
			const items: SchemaEvent[] = Array.isArray(raw)
				? raw
				: raw && typeof raw === "object" && "@graph" in raw && Array.isArray(raw["@graph"])
					? raw["@graph"]!
					: [raw as SchemaEvent];

			for (const item of items) {
				const type = item["@type"];
				if (type !== "MusicEvent" && type !== "Event") continue;
				const name = (item.name ?? "").trim();
				if (!name) continue;
				// Skip parking / VIP packages / non-shows
				if (/parking|not a concert|not an event|vip package|longhorn lounge|meet\s*&\s*greet only/i.test(name)) {
					continue;
				}
				if (!item.startDate) continue;

				const startsAt = parseSchemaDate(item.startDate, timezone);
				const endsAt = item.endDate ? parseSchemaDate(item.endDate, timezone) : null;
				const ticket = offerUrl(item.offers) || item.url || null;
				const img = imageUrl(item.image);
				const desc = item.description ? stripHtml(item.description) : null;

				events.push(
					toPartnerEvent({
						title: name,
						starts_at: startsAt,
						ends_at: endsAt,
						venue_name: venueName,
						address,
						description: desc,
						image_url: img,
						source_url: ticket || item.url || "",
						source_partner: "livenation",
						source_event_id: ticket?.match(/event\/([A-Za-z0-9]+)/i)?.[1] ?? `${name}|${startsAt}`,
						raw_date_text: item.startDate,
						price_text: offerPrice(item.offers),
						ticket_url: ticket,
						confidence: 0.93,
					}),
				);
			}
		} catch {
			// skip bad block
		}
	}

	// Dedupe by source_event_id / title+start
	const seen = new Set<string>();
	const out: PartnerEvent[] = [];
	for (const e of events) {
		const key = e.source_event_id ?? `${e.title}|${e.starts_at}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return out;
}

async function loadHtml(
	url: string,
	browser?: CloudflareEnv["BROWSER"],
): Promise<string> {
	try {
		const html = await fetchLight(url);
		if (/application\/ld\+json|MusicEvent|ticketmaster\.com\/event/i.test(html)) return html;
	} catch {
		/* try browser */
	}
	if (browser) {
		return renderPageContent(browser, url);
	}
	return fetchLight(url);
}

export async function fetchLiveNationEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	browser?: CloudflareEnv["BROWSER"];
	websiteUrl?: string | null;
}): Promise<PartnerEvent[]> {
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 180;
	const cutoff = Date.now() + scrapeDaysAhead * 864e5;
	const origin = new URL(params.calendarUrl).origin;

	// Homepage usually has full JSON-LD; /events is a thin shell
	const candidates = [
		params.websiteUrl,
		origin + "/",
		params.calendarUrl,
		origin + "/events",
	].filter(Boolean) as string[];

	let best: PartnerEvent[] = parseLiveNationJsonLd(
		params.calendarHtml,
		params.venueName,
		params.address,
		params.timezone,
	);

	for (const url of candidates) {
		if (best.length >= 10) break;
		try {
			const html = await loadHtml(url, params.browser);
			const parsed = parseLiveNationJsonLd(html, params.venueName, params.address, params.timezone);
			if (parsed.length > best.length) best = parsed;
		} catch {
			/* continue */
		}
	}

	return best.filter((e) => {
		const t = new Date(e.starts_at).getTime();
		return !Number.isNaN(t) && t <= cutoff && t >= Date.now() - 864e5;
	});
}
