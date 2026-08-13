/**
 * Spacecrafted CMS events (Jester King Brewery et al.).
 *
 * Walkthrough:
 *   1. Calendar page embeds .itemsCollectionContent[data-collections] (base64 JSON)
 *   2. /collections.js script[data-collections] → API base
 *      https://content.spacecrafted.com/{siteId}/c/{type}
 *   3. POST /c/events/{sha256(stableJson({siteId,type,params}))} with params body
 *   4. Response HTML fragment gridView3 → listing cards
 *   5. Detail /event/{slug} → description, full image, buy tickets
 *
 * Signature is SHA-256 of sorted-key JSON (no secret) — mirrors collections.js.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";
import { fetchPageText } from "./fetch-page";

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

export interface SpacecraftedListingCard {
	title: string;
	status: string | null;
	wkday: string | null;
	month: string | null;
	day: string | null;
	path: string | null;
	ticketUrl: string | null;
	imageUrl: string | null;
	venue: string | null;
	dateMd: string | null;
}

export function isSpacecraftedCalendar(html: string, pageUrl: string): boolean {
	const hay = `${pageUrl}\n${html}`;
	return (
		/spacecrafted\.com/i.test(hay) ||
		/eventColl-item|itemsCollectionContent|data-collections/i.test(html) ||
		/jesterkingbrewery\.com/i.test(pageUrl)
	);
}

/** Stable JSON stringify matching Spacecrafted collections.js (sorted keys). */
export function stableStringify(value: unknown): string | undefined {
	if (value !== null && typeof value === "object" && "toJSON" in (value as object)) {
		const tj = (value as { toJSON?: () => unknown }).toJSON;
		if (typeof tj === "function") value = tj.call(value);
	}
	if (value === undefined) return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value !== "object" || value === null) {
		if (value === null) return "null";
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		let o = "[";
		for (let i = 0; i < value.length; i++) {
			if (i) o += ",";
			o += stableStringify(value[i]) || "null";
		}
		return o + "]";
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	let o = "";
	for (const k of keys) {
		const r = stableStringify((value as Record<string, unknown>)[k]);
		if (!r) continue;
		if (o) o += ",";
		o += JSON.stringify(k) + ":" + r;
	}
	return "{" + o + "}";
}

export async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateSpacecraftedVersion(payload: unknown): Promise<string> {
	const s = stableStringify(payload);
	if (!s) throw new Error("Failed to stringify Spacecrafted payload");
	return sha256Hex(s);
}

export function extractSpacecraftedConfig(html: string): {
	siteId: string;
	renderId: string;
	layout: string;
	imageServer: string;
	apiBase: string;
	design: Record<string, unknown>;
	queryDefaults: Record<string, unknown>;
} | null {
	// Prefer collection content block
	const dc = html.match(/data-collections="([A-Za-z0-9+/=]+)"/);
	if (!dc?.[1]) return null;
	let decoded: {
		type?: string;
		params?: {
			layout?: string;
			query?: Record<string, unknown>;
			design?: Record<string, unknown>;
		};
	};
	try {
		decoded = JSON.parse(atob(dc[1]));
	} catch {
		return null;
	}
	const design = (decoded.params?.design ?? {}) as Record<string, unknown>;
	const siteId = String(design.siteId ?? "");
	const renderId = String(design.renderId ?? "");
	if (!siteId || !renderId) return null;

	// script[data-collections] holds API URL template
	const apiB64 = html.match(
		/<script[^>]+src=["'][^"']*collections\.js[^"']*["'][^>]*data-collections=["']([A-Za-z0-9+/=]+)["']/i,
	)?.[1]
		|| html.match(
			/data-collections=["']([A-Za-z0-9+/=]+)["'][^>]*src=["'][^"']*collections\.js/i,
		)?.[1];
	let apiBase = `https://content.spacecrafted.com/${siteId}/c/{type}`;
	if (apiB64) {
		try {
			const tpl = atob(apiB64);
			if (/\{type\}/.test(tpl)) apiBase = tpl;
		} catch {
			/* keep default */
		}
	}

	return {
		siteId,
		renderId,
		layout: String(decoded.params?.layout ?? "gridView3"),
		imageServer: String(design.imageServer ?? "https://static.spacecrafted.com"),
		apiBase,
		design,
		queryDefaults: (decoded.params?.query ?? {
			snapshot: "published",
			limit: 16,
			skip: 0,
			sort: false,
			asc: true,
		}) as Record<string, unknown>,
	};
}

function decodeHtml(s: string | null | undefined): string {
	if (!s) return "";
	return s
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
}

export function parseSpacecraftedListingHtml(html: string): SpacecraftedListingCard[] {
	if (!html) return [];
	const items: SpacecraftedListingCard[] = [];
	const chunks = html.split(/<div class="item eventColl-item/);
	for (let i = 1; i < chunks.length; i++) {
		const c = chunks[i]!;
		const status = c.match(/data-event-status="([^"]+)"/)?.[1] ?? null;
		const wkday = decodeHtml(c.match(/class="eventColl-wkday"[^>]*>([^<]+)/)?.[1]);
		const month = decodeHtml(c.match(/class="eventColl-month"[^>]*>([^<]+)/)?.[1]);
		const day = decodeHtml(c.match(/class="eventColl-date"[^>]*>([^<]+)/)?.[1]);
		const title = decodeHtml(
			c.match(/class="eventColl-eventInfo"[^>]*>\s*<a[^>]*>([^<]+)/)?.[1] ||
				c.match(/class="contentTitle eventColl-mainTitles"[^>]*>([^<]+)/)?.[1],
		);
		const path = c.match(/href="(\/event\/[^"]+)"/)?.[1] ?? null;
		const buy =
			c.match(/class="[^"]*eventColl-statusBtn--buy[^"]*"[^>]*href="([^"]+)"/)?.[1] ||
			c.match(/href="([^"]+)"[^>]*class="[^"]*eventColl-statusBtn--buy/)?.[1] ||
			null;
		const img = c.match(/src="(https:\/\/static\.spacecrafted\.com[^"]+)"/)?.[1] ?? null;
		const venue = decodeHtml(c.match(/eventColl-detail--venue[^>]*>([^<]+)/)?.[1]) || null;
		const dateMd = decodeHtml(c.match(/eventColl-detail--date[^>]*>([^<]+)/)?.[1]) || null;
		if (!title && !path) continue;
		items.push({
			title: title || "Untitled",
			status,
			wkday: wkday || null,
			month: month || null,
			day: day || null,
			path,
			ticketUrl: buy ? decodeHtml(buy) : null,
			imageUrl: img,
			venue,
			dateMd,
		});
	}
	return items;
}

async function postCollectionPage(params: {
	apiBase: string;
	siteId: string;
	type: string;
	layout: string;
	design: Record<string, unknown>;
	query: Record<string, unknown>;
}): Promise<{ html: string; layoutKey: string }> {
	const body = {
		query: params.query,
		layouts: { [params.layout]: null } as Record<string, null>,
		design: params.design,
	};
	const version = await generateSpacecraftedVersion({
		siteId: params.siteId,
		type: params.type,
		params: body,
	});
	const url = `${params.apiBase.replace("{type}", params.type)}/${version}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Origin: "https://jesterkingbrewery.com",
			Referer: "https://jesterkingbrewery.com/events-calendar",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Spacecrafted API HTTP ${res.status} for skip=${params.query.skip}`);
	}
	const text = await res.text();
	if (!text.trim()) return { html: "", layoutKey: params.layout };
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { html: "", layoutKey: params.layout };
	}
	const layoutKey =
		Object.keys(json).find((k) => k !== "__sys" && typeof json[k] === "string") ?? params.layout;
	const html = typeof json[layoutKey] === "string" ? (json[layoutKey] as string) : "";
	return { html, layoutKey };
}

function parseClock(hm: string): { h: number; min: number } | null {
	const m = hm.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
	if (!m) return null;
	let h = Number(m[1]);
	const min = Number(m[2] || 0);
	const ap = m[3]!.toLowerCase();
	if (ap === "pm" && h < 12) h += 12;
	if (ap === "am" && h === 12) h = 0;
	return { h, min };
}

function extractTimes(
	title: string,
	description: string | null,
): { start: { h: number; min: number } | null; end: { h: number; min: number } | null; raw: string | null } {
	const hay = `${title}\n${description || ""}`;
	const range = hay.match(
		/(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
	);
	if (range) {
		return {
			start: parseClock(range[1]!),
			end: parseClock(range[2]!),
			raw: range[0],
		};
	}
	const single = hay.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
	if (single) {
		return { start: parseClock(single[1]!), end: null, raw: single[1]! };
	}
	// 10:00 AM style
	const formal = hay.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
	if (formal) {
		return { start: parseClock(formal[1]!), end: null, raw: formal[1]! };
	}
	return { start: null, end: null, raw: null };
}

function cardToYmd(card: SpacecraftedListingCard, fallbackYear: number): string | null {
	const mNum = MONTHS[(card.month || "").toLowerCase()];
	const dNum = Number(card.day);
	if (!mNum || !dNum) {
		// MM/DD from detail list
		const md = (card.dateMd || "").match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
		if (md) {
			const month = Number(md[1]);
			const day = Number(md[2]);
			let year = md[3] ? Number(md[3]) : fallbackYear;
			if (year < 100) year += 2000;
			return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		}
		return null;
	}
	// If month is earlier than "now" by a lot (e.g. Jan while we're in Jul), roll year
	let year = fallbackYear;
	const now = new Date();
	const nowMonth = now.getUTCMonth() + 1;
	// Local-ish: if card month is far behind current month and day already passed, next year
	if (mNum < nowMonth - 1) {
		// winter→spring of next year when crawling late year; keep simple for TX season
		// Only roll if month is Jan-Mar and we're Oct+
		if (nowMonth >= 10 && mNum <= 3) year = fallbackYear + 1;
	}
	return `${year}-${String(mNum).padStart(2, "0")}-${String(dNum).padStart(2, "0")}`;
}

function stripHtml(text: string): string {
	return decodeHtml(
		text
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/p>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]{2,}/g, " "),
	).trim();
}

async function enrichDetail(
	origin: string,
	card: SpacecraftedListingCard,
): Promise<{
	description: string | null;
	imageUrl: string | null;
	ticketUrl: string | null;
	title: string;
}> {
	if (!card.path) {
		return {
			description: null,
			imageUrl: card.imageUrl,
			ticketUrl: card.ticketUrl,
			title: card.title,
		};
	}
	const url = card.path.startsWith("http") ? card.path : `${origin}${card.path}`;
	try {
		const html = await fetchPageText(url);
		const title =
			decodeHtml(
				html.match(/class="eventColl-eventInfo"[^>]*>\s*([^<\n]+)/)?.[1] ||
					html.match(/<h2 class="eventColl-eventInfo"[^>]*>([^<]+)/)?.[1],
			) || card.title;
		const descHtml =
			html.match(
				/class="blockText blockInnerContent eventColl-section eventColl-desc"[^>]*>([\s\S]*?)<\/div>/i,
			)?.[1] ||
			html.match(/class="[^"]*eventColl-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
			"";
		const description = stripHtml(descHtml).slice(0, 4000) || null;
		const imgs = [...html.matchAll(/src="(https:\/\/static\.spacecrafted\.com\/[^"]+)"/gi)]
			.map((m) => m[1]!)
			.filter(
				(u) =>
					!/logo/i.test(u) &&
					!/brewersAssoc|CertifiedBrewery|trichain|TCBG/i.test(u),
			);
		const contentImg =
			html.match(/class="contentImg"[^>]*src="([^"]+)"/i)?.[1] ||
			html.match(/src="([^"]+)"[^>]*class="contentImg"/i)?.[1] ||
			imgs[0] ||
			card.imageUrl;
		const buy =
			html.match(/class="[^"]*eventColl-statusBtn--buy[^"]*"[^>]*href="([^"]+)"/i)?.[1] ||
			html.match(/href="([^"]+)"[^>]*>\s*Buy Tickets/i)?.[1] ||
			card.ticketUrl;
		return {
			description,
			imageUrl: contentImg || null,
			ticketUrl: buy ? decodeHtml(buy) : null,
			title,
		};
	} catch {
		return {
			description: null,
			imageUrl: card.imageUrl,
			ticketUrl: card.ticketUrl,
			title: card.title,
		};
	}
}

function absoluteUrl(origin: string, pathOrUrl: string | null): string | null {
	if (!pathOrUrl) return null;
	if (pathOrUrl.startsWith("http")) return pathOrUrl;
	if (pathOrUrl.startsWith("/")) return `${origin}${pathOrUrl}`;
	return pathOrUrl;
}

export async function fetchSpacecraftedEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
	maxEvents?: number;
	enrichDetails?: boolean;
}): Promise<PartnerEvent[]> {
	const config = extractSpacecraftedConfig(params.calendarHtml);
	if (!config) {
		throw new Error("Could not parse Spacecrafted data-collections config from calendar HTML");
	}

	const origin = new URL(params.calendarUrl).origin;
	const limit = Number(config.queryDefaults.limit) || 16;
	const maxEvents = params.maxEvents ?? 80;
	const enrichDetails = params.enrichDetails !== false;
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 90;
	const year = new Date().getFullYear();

	const cards: SpacecraftedListingCard[] = [];
	for (let skip = 0; skip < maxEvents && cards.length < maxEvents; skip += limit) {
		const { html } = await postCollectionPage({
			apiBase: config.apiBase,
			siteId: config.siteId,
			type: "events",
			layout: config.layout,
			design: config.design,
			query: {
				...config.queryDefaults,
				snapshot: config.queryDefaults.snapshot ?? "published",
				limit,
				skip,
				sort: config.queryDefaults.sort ?? false,
				asc: config.queryDefaults.asc ?? true,
			},
		});
		const pageCards = parseSpacecraftedListingHtml(html);
		if (pageCards.length === 0) break;
		cards.push(...pageCards);
		if (pageCards.length < limit) break;
	}

	const now = Date.now() - 2 * 60 * 60 * 1000;
	const cutoff = Date.now() + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const out: PartnerEvent[] = [];

	for (const card of cards.slice(0, maxEvents)) {
		const ymd = cardToYmd(card, year);
		if (!ymd) continue;

		const detail = enrichDetails
			? await enrichDetail(origin, card)
			: {
					description: null,
					imageUrl: card.imageUrl,
					ticketUrl: card.ticketUrl,
					title: card.title,
				};

		const title = detail.title || card.title;
		const times = extractTimes(title, detail.description);
		// Defaults: goat walk ~8pm if titled as such without time; else noon for free music slots
		let startH = times.start?.h ?? (/goat walk/i.test(title) ? 20 : 12);
		let startMin = times.start?.min ?? 0;
		let endH = times.end?.h ?? null;
		let endMin = times.end?.min ?? 0;
		// If only start and goat walk, estimate 1h duration
		if (endH === null && /goat walk/i.test(title) && times.start) {
			endH = startH + 1;
			endMin = startMin;
		}
		// Live music ranges already parsed from title

		const startLocal = `${ymd} ${String(startH).padStart(2, "0")}:${String(startMin).padStart(2, "0")}:00`;
		let endsAt: string | null = null;
		try {
			const startsAt = localWallTimeToUtcIso(startLocal, params.timezone);
			const startMs = new Date(startsAt).getTime();
			if (startMs < now || startMs > cutoff) continue;

			if (endH !== null) {
				let endYmd = ymd;
				// overnight end before start clock → next day
				if (endH < startH || (endH === startH && endMin < startMin)) {
					const [y, m, d] = ymd.split("-").map(Number);
					const dt = new Date(Date.UTC(y!, m! - 1, d! + 1));
					endYmd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
				}
				const endLocal = `${endYmd} ${String(endH).padStart(2, "0")}:${String(endMin).padStart(2, "0")}:00`;
				endsAt = localWallTimeToUtcIso(endLocal, params.timezone);
			}

			const eventUrl = absoluteUrl(origin, card.path) || params.calendarUrl;
			const ticketUrl = absoluteUrl(origin, detail.ticketUrl || card.ticketUrl);
			const price =
				detail.description?.match(/\$\s*(\d+(?:\.\d{2})?)\s*per person/i)?.[0] ||
				detail.description?.match(/Tickets? are \$\s*(\d+)/i)?.[0] ||
				null;

			// Clean title: keep artist + time as venue publishes (title truth)
			out.push(
				toPartnerEvent({
					title,
					starts_at: startsAt,
					ends_at: endsAt,
					venue_name: params.venueName,
					address: params.address,
					description: detail.description,
					image_url: detail.imageUrl || card.imageUrl,
					source_url: eventUrl,
					source_partner: "spacecrafted",
					source_event_id: card.path?.replace(/^\/event\//, "") ?? null,
					raw_date_text: [card.wkday, card.month, card.day, times.raw].filter(Boolean).join(" "),
					price_text: price,
					ticket_url: ticketUrl,
					confidence: 0.9,
				}),
			);
		} catch {
			continue;
		}
	}

	// Dedupe by fingerprint (title+start)
	const seen = new Set<string>();
	return out.filter((e) => {
		if (seen.has(e.fingerprint)) return false;
		seen.add(e.fingerprint);
		return true;
	});
}
