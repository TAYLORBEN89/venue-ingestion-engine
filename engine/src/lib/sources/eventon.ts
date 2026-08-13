/**
 * EventON (WordPress) adapter — Speakeasy Austin, Long Center, etc.
 *
 * Primary walkthrough (matches venue UI):
 *   1. https://…/calendar/  (or events list with ajde_evcal_calendar)
 *   2. #evcal_list .eventon_events_list → each a.desc_trig / a.evcal_list_a
 *   3. Detail page: JSON-LD + data-location_* + evo_metarow_fimg + eventon_full_description
 *   4. #evcal_next month chevron → repeat (the_ajax_hook direction=next)
 *
 * AJAX: jQuery serializes shortcode as nested form fields shortcode[key]=val
 *   - eventon_init_load → cals[calId][sc][key]=val → cals[id].html for #evcal_list
 *   - the_ajax_hook → shortcode[key]=val → data.html for month switch
 *
 * Fallback: Yoast ajde_events sitemaps + RSS when calendar AJAX is unavailable.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";
import { localWallTimeToUtcIso } from "./local-time";

const SKIP_SLUGS = new Set([
	"page",
	"feed",
	"category",
	"tag",
	"author",
	"var",
	"event-type",
	"event-type-2",
	"event-location",
	"event-organizer",
]);

export function isEventOnCalendar(html: string, pageUrl: string): boolean {
	const haystack = `${pageUrl}\n${html}`;
	return (
		/eventon|evcal_|ajde_evcal|ajde_events|eventon_events_list/i.test(haystack) ||
		/speakeasyaustin\.com/i.test(pageUrl) ||
		/thelongcenter\.org/i.test(pageUrl)
	);
}

function stripHtml(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&#039;|&#39;|&apos;/gi, "'")
		.replace(/&#8217;/g, "'")
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
		.replace(/&quot;/gi, '"')
		.replace(/&nbsp;/gi, " ")
		.replace(/&ldquo;|&rdquo;/gi, '"')
		.replace(/&lsquo;|&rsquo;/gi, "'")
		.replace(/&mdash;|&ndash;/gi, "—")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function originOf(url: string): string {
	return new URL(url).origin;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function normalizeEventUrl(raw: string, baseUrl: string): string | null {
	try {
		const u = new URL(raw.replace(/&amp;/gi, "&"), baseUrl);
		u.search = "";
		u.hash = "";
		const path = u.pathname.replace(/\/+$/, "") || "/";
		if (!/\/events\//i.test(path)) return null;
		const parts = path.split("/").filter(Boolean);
		const eventsIdx = parts.findIndex((p) => p.toLowerCase() === "events");
		if (eventsIdx < 0 || !parts[eventsIdx + 1]) return null;
		const slug = parts[eventsIdx + 1];
		if (SKIP_SLUGS.has(slug.toLowerCase())) return null;
		if (/^\d+$/.test(slug)) return null;
		if (parts.some((p) => /^(feed|amp)$/i.test(p))) return null;
		return `${u.origin}${path}/`;
	} catch {
		return null;
	}
}

/** Base post URL without /var/ri-N occurrence suffix. */
export function eventOnBaseUrl(eventUrl: string): string {
	const m = eventUrl.match(/^(https?:\/\/[^/]+\/events\/[^/]+)/i);
	return m ? `${m[1]}/` : eventUrl;
}

/** Append nested object as jQuery-style form fields: prefix[key][sub]=val */
function appendNested(params: URLSearchParams, prefix: string, obj: unknown): void {
	if (obj === null || obj === undefined) {
		params.append(prefix, "");
		return;
	}
	if (typeof obj !== "object" || Array.isArray(obj)) {
		params.append(prefix, String(obj));
		return;
	}
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		appendNested(params, `${prefix}[${k}]`, v);
	}
}

/** Parse data-sc JSON from .evo_cal_data on the calendar page. */
export function extractEventOnShortcode(html: string): Record<string, unknown> | null {
	const scWide = html.match(
		/class=['"]evo_cal_data['"][\s\S]{0,40}data-sc=['"](\{[\s\S]{50,6000})['"]/i,
	);
	if (!scWide?.[1]) return null;
	const s = scWide[1];
	for (let end = Math.min(s.length, 3000); end > 80; end--) {
		const cand = s.slice(0, end);
		if (!cand.endsWith("}")) continue;
		try {
			return JSON.parse(cand) as Record<string, unknown>;
		} catch {
			// keep shrinking
		}
	}
	return null;
}

export function extractEventOnCalendarId(html: string): string | null {
	return (
		html.match(/id=['"](evcal_calendar_\d+)['"]/i)?.[1] ||
		html.match(/id=['"](ajde_evcal_cal\w*)['"]/i)?.[1] ||
		null
	);
}

/**
 * Event links from #evcal_list — prefer a.desc_trig / a.evcal_list_a (UI walkthrough),
 * then every /events/ href in the list HTML (AJAX responses are list-only fragments).
 */
export function extractEventOnListUrls(html: string, pageUrl: string): string[] {
	const origin = originOf(pageUrl);
	const out = new Set<string>();

	// Prefer list container when present (static page); AJAX html is already the list body
	const list =
		html.match(
			/id=['"]evcal_list['"][\s\S]*?(?=<div[^>]+id=['"]evcal_footer|$)/i,
		)?.[0] || html;

	const patterns = [
		// User walkthrough: a.desc_trig.evcal_list_a
		/class=["'][^"']*desc_trig[^"']*["'][^>]*href=["']([^"']+)["']/gi,
		/href=["']([^"']+)["'][^>]*class=["'][^"']*desc_trig[^"']*["']/gi,
		/class=["'][^"']*evcal_list_a[^"']*["'][^>]*href=["']([^"']+)["']/gi,
		/href=["']([^"']+)["'][^>]*class=["'][^"']*evcal_list_a[^"']*["']/gi,
		// Each row: .eventon_list_event
		/class=["'][^"']*eventon_list_event[^"']*["'][\s\S]{0,800}?href=["']([^"']*\/events\/[^"']+)["']/gi,
	];

	for (const re of patterns) {
		for (const m of list.matchAll(re)) {
			const n = normalizeEventUrl(m[1]!, origin);
			if (n) out.add(n);
		}
	}

	// Always also collect any /events/ occurrence/permalink in this list fragment
	for (const m of list.matchAll(/href=["']([^"']*\/events\/[^"'#?]+)["']/gi)) {
		const n = normalizeEventUrl(m[1]!, origin);
		if (n) out.add(n);
	}

	return [...out];
}

export function extractEventOnEventUrls(html: string, pageUrl: string): string[] {
	const origin = originOf(pageUrl);
	const out = new Set<string>(extractEventOnListUrls(html, pageUrl));

	for (const m of html.matchAll(/href=["']([^"']*\/events\/[^"'#?]+)["']/gi)) {
		const n = normalizeEventUrl(m[1]!, pageUrl);
		if (n) out.add(n);
	}
	for (const m of html.matchAll(
		new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/events/[^"'\\s<]+`, "gi"),
	)) {
		const n = normalizeEventUrl(m[0], pageUrl);
		if (n) out.add(n);
	}
	return [...out];
}

export function extractEventOnUrlsFromRss(rssXml: string, baseUrl: string): string[] {
	const out = new Set<string>();
	for (const m of rssXml.matchAll(/<link>([^<]+)<\/link>/gi)) {
		const raw = m[1]!.replace(/&#038;/g, "&").replace(/&amp;/g, "&").trim();
		if (!/\/events\//i.test(raw)) continue;
		const n = normalizeEventUrl(raw, baseUrl);
		if (n) out.add(n);
	}
	return [...out];
}

async function postAdminAjax(
	origin: string,
	params: URLSearchParams,
	referer: string,
): Promise<unknown> {
	const ajaxUrl = new URL("/wp-admin/admin-ajax.php", origin).toString();
	const res = await fetch(ajaxUrl, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded; charset=UTF-8",
			"x-requested-with": "XMLHttpRequest",
			referer,
			origin,
			accept: "application/json,text/javascript,*/*",
			"user-agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
		body: params.toString(),
	});
	if (!res.ok) throw new Error(`EventON AJAX HTTP ${res.status}`);
	const text = await res.text();
	if (!text || text === "0") return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { html: text };
	}
}

function listHtmlFromAjaxResponse(data: unknown, calId: string | null): string {
	if (!data || typeof data !== "object") return "";
	const d = data as Record<string, unknown>;
	if (typeof d.html === "string" && d.html.length > 50) return d.html;
	const cals = d.cals;
	if (cals && typeof cals === "object") {
		const map = cals as Record<string, { html?: string }>;
		if (calId && map[calId]?.html) return map[calId]!.html!;
		for (const v of Object.values(map)) {
			if (v?.html && v.html.length > 50) return v.html;
		}
	}
	return "";
}

function shiftMonthShortcode(
	sc: Record<string, unknown>,
	monthDelta: number,
): Record<string, unknown> {
	const fs = Number(sc.focus_start_date_range);
	if (!Number.isFinite(fs) || fs <= 0) return { ...sc };
	const d0 = new Date(fs * 1000);
	const y = d0.getUTCFullYear();
	const m = d0.getUTCMonth() + monthDelta;
	const nextStart = Math.floor(Date.UTC(y, m, 1) / 1000);
	const nextEnd = Math.floor(Date.UTC(y, m + 1, 0, 23, 59, 59) / 1000);
	return {
		...sc,
		focus_start_date_range: String(nextStart),
		focus_end_date_range: String(nextEnd),
		month_incre: String(monthDelta),
	};
}

/**
 * Walk calendar months like the UI: init load → #evcal_list → #evcal_next × N.
 */
export async function discoverEventUrlsFromCalendarAjax(params: {
	calendarHtml: string;
	calendarUrl: string;
	scrapeDaysAhead: number;
}): Promise<string[]> {
	const origin = originOf(params.calendarUrl);
	const calId = extractEventOnCalendarId(params.calendarHtml);
	let sc = extractEventOnShortcode(params.calendarHtml);
	if (!sc) return [];

	const urls = new Set<string>();
	const months = Math.min(Math.ceil(params.scrapeDaysAhead / 28) + 1, 6);

	// Current month via eventon_init_load (fills empty #evcal_list)
	if (calId) {
		try {
			const p = new URLSearchParams();
			p.set("action", "eventon_init_load");
			appendNested(p, `cals[${calId}][sc]`, sc);
			const data = await postAdminAjax(origin, p, params.calendarUrl);
			const listHtml = listHtmlFromAjaxResponse(data, calId);
			for (const u of extractEventOnListUrls(listHtml, params.calendarUrl)) urls.add(u);
			// Init may return updated shortcode
			const cals = (data as { cals?: Record<string, { sc?: Record<string, unknown> }> })?.cals;
			if (cals?.[calId]?.sc && typeof cals[calId]!.sc === "object") {
				sc = { ...sc, ...cals[calId]!.sc };
			}
		} catch {
			// fall through to the_ajax_hook
		}
	}

	// Also try the_ajax_hook for current month (works without cal id)
	if (urls.size === 0) {
		try {
			const p = new URLSearchParams();
			p.set("action", "the_ajax_hook");
			p.set("direction", "none");
			p.set("ajaxtype", "none");
			appendNested(p, "shortcode", sc);
			const data = await postAdminAjax(origin, p, params.calendarUrl);
			const listHtml = listHtmlFromAjaxResponse(data, calId);
			for (const u of extractEventOnListUrls(listHtml, params.calendarUrl)) urls.add(u);
		} catch {
			// no ajax
		}
	}

	// #evcal_next — switchmonth for remaining months in horizon
	for (let delta = 1; delta < months; delta++) {
		const nextSc = shiftMonthShortcode(sc, delta);
		try {
			const p = new URLSearchParams();
			p.set("action", "the_ajax_hook");
			p.set("direction", "next");
			p.set("ajaxtype", "switchmonth");
			appendNested(p, "shortcode", nextSc);
			const data = await postAdminAjax(origin, p, params.calendarUrl);
			const listHtml = listHtmlFromAjaxResponse(data, calId);
			const before = urls.size;
			for (const u of extractEventOnListUrls(listHtml, params.calendarUrl)) urls.add(u);
			if (urls.size === before) {
				// try none direction with shifted focus
				const p2 = new URLSearchParams();
				p2.set("action", "the_ajax_hook");
				p2.set("direction", "none");
				p2.set("ajaxtype", "none");
				appendNested(p2, "shortcode", nextSc);
				const data2 = await postAdminAjax(origin, p2, params.calendarUrl);
				const list2 = listHtmlFromAjaxResponse(data2, calId);
				for (const u of extractEventOnListUrls(list2, params.calendarUrl)) urls.add(u);
			}
		} catch {
			// stop month walk
			break;
		}
		await sleep(120);
	}

	return [...urls];
}

type JsonLdEvent = {
	"@type"?: string | string[];
	name?: string;
	startDate?: string;
	endDate?: string;
	description?: string;
	image?: string | string[] | { url?: string };
	url?: string;
};

function isEventType(t: string | string[] | undefined): boolean {
	if (!t) return false;
	const arr = Array.isArray(t) ? t : [t];
	return arr.some((x) => String(x).toLowerCase() === "event");
}

function parseJsonLdEvents(html: string): JsonLdEvent[] {
	const out: JsonLdEvent[] = [];
	for (const block of html.matchAll(
		/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		try {
			const data = JSON.parse(block[1]!.trim()) as unknown;
			const nodes = Array.isArray(data) ? data : [data];
			for (const node of nodes) {
				if (!node || typeof node !== "object") continue;
				const n = node as JsonLdEvent & { "@graph"?: unknown[] };
				if (Array.isArray(n["@graph"])) {
					for (const g of n["@graph"]) {
						if (g && typeof g === "object" && isEventType((g as JsonLdEvent)["@type"])) {
							out.push(g as JsonLdEvent);
						}
					}
				} else if (isEventType(n["@type"]) || n.startDate || n.name) {
					out.push(n);
				}
			}
		} catch {
			// ignore
		}
	}
	return out;
}

/** EventON recurrence URLs often end with /var/ri-… — strip for stable source keys. */
function cleanEventOnPublicUrl(url: string): string {
	const cleaned = url
		.replace(/\/var\/ri-[^/?#]+/gi, "")
		.replace(/\/l-[^/?#]+/gi, "")
		.replace(/\/+$/, "");
	return cleaned || url;
}

/**
 * Build partner events from schema.org Event JSON-LD on a page.
 * Donn's Depot (EventON 5) puts the live week on the homepage, while /event-schedule/ is an empty shell.
 */
export function partnerEventsFromJsonLdPage(params: {
	html: string;
	pageUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	nowMs?: number;
	cutoffMs?: number;
}): PartnerEvent[] {
	const now = params.nowMs ?? Date.now() - 60 * 60 * 1000;
	const cutoff = params.cutoffMs ?? Date.now() + 180 * 24 * 60 * 60 * 1000;
	const out: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const ld of parseJsonLdEvents(params.html)) {
		if (!isEventType(ld["@type"]) && !ld.startDate) continue;
		const title = stripHtml(String(ld.name || "").trim());
		if (!title || title.length < 2) continue;
		if (!ld.startDate) continue;
		const startsAt = parseEventOnStartDate(ld.startDate, params.timezone);
		if (!startsAt) continue;
		const t = Date.parse(startsAt);
		if (Number.isNaN(t) || t < now || t > cutoff) continue;

		let endsAt: string | null = null;
		if (ld.endDate) {
			const e = parseEventOnStartDate(ld.endDate, params.timezone);
			if (e && Date.parse(e) > t) endsAt = e;
		}

		const rawUrl = typeof ld.url === "string" && ld.url.startsWith("http") ? ld.url : params.pageUrl;
		const sourceUrl = cleanEventOnPublicUrl(rawUrl);
		const imageUrl =
			typeof ld.image === "string"
				? ld.image
				: Array.isArray(ld.image) && typeof ld.image[0] === "string"
					? ld.image[0]
					: null;

		const key = `${title.toLowerCase()}|${startsAt}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const idFromUrl = sourceUrl.match(/\/events\/([^/?#]+)/i)?.[1] ?? null;
		out.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: endsAt,
				venue_name: params.venueName,
				address: params.address,
				description: ld.description ? stripHtml(String(ld.description)).slice(0, 4000) : null,
				image_url: imageUrl,
				source_url: sourceUrl,
				source_partner: "eventon",
				source_event_id: idFromUrl
					? `eventon:${idFromUrl}#${startsAt}`
					: `eventon:${sourceUrl}#${startsAt}`,
				raw_date_text: ld.startDate,
				ticket_url: sourceUrl,
				confidence: 1,
			}),
		);
	}
	return out;
}

/**
 * EventON often emits startDate like "2026-7-1T20:00:00" (no zero-pad, local wall time).
 */
export function parseEventOnStartDate(raw: string, timezone: string): string | null {
	const s = raw.trim();
	const m = s.match(
		/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:([+-]\d{1,2}:?\d{2})|Z)?/i,
	);
	if (m) {
		const y = m[1]!;
		const mo = String(Number(m[2])).padStart(2, "0");
		const d = String(Number(m[3])).padStart(2, "0");
		const hh = String(Number(m[4])).padStart(2, "0");
		const mm = m[5]!;
		const ss = m[6] ?? "00";
		const offset = m[7];
		if (offset || /Z$/i.test(s)) {
			const normalized = `${y}-${mo}-${d}T${hh}:${mm}:${ss}${offset ? formatOffset(offset) : "Z"}`;
			const t = Date.parse(normalized);
			if (!Number.isNaN(t)) return new Date(t).toISOString();
		}
		try {
			return localWallTimeToUtcIso(`${y}-${mo}-${d} ${hh}:${mm}:${ss}`, timezone);
		} catch {
			return null;
		}
	}
	const t = Date.parse(s);
	if (!Number.isNaN(t)) return new Date(t).toISOString();
	return null;
}

function formatOffset(off: string): string {
	const m = off.match(/^([+-])(\d{1,2}):?(\d{2})$/);
	if (!m) return off;
	return `${m[1]}${String(Number(m[2])).padStart(2, "0")}:${m[3]}`;
}

function extractImage(html: string, ld?: JsonLdEvent): string | null {
	if (ld?.image) {
		if (typeof ld.image === "string") return ld.image.replace(/-\d+x\d+(\.[a-z]+)$/i, "$1");
		if (Array.isArray(ld.image) && typeof ld.image[0] === "string") {
			return ld.image[0].replace(/-\d+x\d+(\.[a-z]+)$/i, "$1");
		}
		if (typeof ld.image === "object" && ld.image && "url" in ld.image && ld.image.url) {
			return ld.image.url.replace(/-\d+x\d+(\.[a-z]+)$/i, "$1");
		}
	}
	// Long Center card / lightbox: .evocard_main_image data-f (full-res) or background-image
	const dataF =
		html.match(
			/class=["'][^"']*evocard_main_image[^"']*["'][^>]*data-f=["'](https?:\/\/[^"']+)["']/i,
		)?.[1] ||
		html.match(
			/data-f=["'](https?:\/\/[^"']*\/wp-content\/uploads\/[^"']+)["']/i,
		)?.[1];
	if (dataF) return dataF.replace(/-\d+x\d+(\.[a-z]+)$/i, "$1");

	// User walkthrough: evo_metarow_fimg background-image
	const bg =
		html.match(
			/evocard_main_image[^>]*style=["'][^"']*background-image:\s*url\((['"]?)([^)'"]+)\1\)/i,
		)?.[2] ||
		html.match(
			/evo_metarow_fimg[^>]*style=["'][^"']*background-image:\s*url\((['"]?)([^)'"]+)\1\)/i,
		)?.[2] ||
		html.match(
			/class=["'][^"']*evo_metarow_fimg[^"']*["'][^>]*style=["'][^"']*url\((['"]?)([^)'"]+)\1\)/i,
		)?.[2] ||
		html.match(
			/background-image:\s*url\((['"]?)(https?:\/\/[^)'"]+\.(?:jpe?g|png|webp|gif))\1\)/i,
		)?.[2];
	if (bg) return bg.replace(/-\d+x\d+(\.[a-z]+)$/i, "$1");
	const og =
		html.match(/property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1] ||
		html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
	return og ? og.replace(/-\d+x\d+(\.[a-z]+)$/i, "$1") : null;
}

function extractDescription(html: string, ld?: JsonLdEvent): string | null {
	// Long Center Tessitura embed: .tn-event-detail__performance-details-container
	const tessitura =
		html.match(
			/class=["'][^"']*tn-event-detail__performance-details-container[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div|<\/section|<\/main)/i,
		)?.[1] ||
		html.match(
			/class=["'][^"']*tn-event-detail__performance-details[^"']*["'][^>]*>([\s\S]{80,8000}?)<\/div>/i,
		)?.[1] ||
		"";
	// User walkthrough: eventon_full_description → eventon_desc_in
	const full =
		html.match(
			/class=['"][^'"]*eventon_full_description[^'"]*['"][^>]*>([\s\S]*?)<\/div>\s*(?:<div|<\/div>)/i,
		)?.[1] || "";
	const block =
		(tessitura && tessitura.length > 40 ? tessitura : "") ||
		html.match(/class=['"][^'"]*eventon_desc_in[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
		html.match(/itemprop=['"]description['"][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
		full ||
		(typeof ld?.description === "string" ? ld.description : "") ||
		html.match(/property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] ||
		"";
	let text = stripHtml(block);
	text = text.replace(/^Event Details\s*/i, "").trim();
	if (text.length < 40) return null;
	return text.slice(0, 4000);
}

function extractTitle(html: string, ld?: JsonLdEvent): string | null {
	// EventON JSON-LD often has HTML entities in name ("Donn &amp; …", "Murphy&#039;s …").
	// Always decode — previously only HTML fallbacks ran through stripHtml.
	const fromLd = ld?.name?.trim();
	if (fromLd) {
		return stripHtml(fromLd)
			.replace(/\s*[|–-]\s*Speakeasy.*$/i, "")
			.replace(/\s*[|–-]\s*Long Center.*$/i, "")
			.trim();
	}
	const fromEv =
		html.match(/class=['"][^'"]*evcal_event_title[^'"]*['"][^>]*>([\s\S]*?)<\//i)?.[1] ||
		html.match(/class=['"][^'"]*evo_event_title[^'"]*['"][^>]*>([\s\S]*?)<\//i)?.[1] ||
		html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] ||
		html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	if (!fromEv) return null;
	return stripHtml(fromEv)
		.replace(/\s*[|–-]\s*Speakeasy.*$/i, "")
		.replace(/\s*[|–-]\s*Long Center.*$/i, "")
		.trim();
}

function extractTicketUrl(html: string, fallback: string): string {
	const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) =>
		m[1]!.replace(/&amp;/g, "&"),
	);
	// Long Center Tessitura: my.thelongcenter.org/####  (prefer over generic "buy")
	const tessitura = hrefs.find((h) => /my\.thelongcenter\.org\/\d+/i.test(h));
	if (tessitura) return tessitura.replace(/[?&]_ga=[^&]+/g, "").replace(/\?$/, "");

	const buy = hrefs.find((h) =>
		/eventbrite\.com\/e\/|ticketmaster\.com|axs\.com|seetickets|etix\.com|dice\.fm|prekindle\.com|ticketweb\.com|my\.thelongcenter\.org/i.test(
			h,
		),
	);
	if (buy) return buy.replace(/[?&]_ga=[^&]+/g, "").replace(/\?$/, "");
	const bare = html.match(
		/https?:\/\/(?:www\.)?eventbrite\.com\/e\/[0-9]+[^"'<\s]*/i,
	)?.[0];
	return bare?.replace(/&amp;/g, "&") ?? fallback;
}

export async function parseEventOnDetailPage(params: {
	html: string;
	pageUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
}): Promise<PartnerEvent[]> {
	const { html, pageUrl, venueName, address, timezone } = params;
	const ldEvents = parseJsonLdEvents(html);
	const ld = ldEvents.find((e) => e.startDate) ?? ldEvents[0];
	const title = extractTitle(html, ld);
	if (!title) return [];

	const startRaw =
		ld?.startDate ||
		html.match(/"startDate"\s*:\s*"([^"]+)"/)?.[1] ||
		html.match(/itemprop=['"]startDate['"][^>]*content=['"]([^'"]+)/i)?.[1] ||
		null;

	const startsAt = startRaw ? parseEventOnStartDate(startRaw, timezone) : null;
	if (!startsAt) return [];

	let endsAt: string | null = null;
	if (ld?.endDate) {
		const e = parseEventOnStartDate(ld.endDate, timezone);
		if (e && Date.parse(e) > Date.parse(startsAt)) endsAt = e;
	}

	const imageUrl = extractImage(html, ld);
	const description = extractDescription(html, ld);
	const ticketUrl = extractTicketUrl(html, pageUrl);
	const sourceEventId =
		html.match(/data-event_id=['"](\d+)['"]/i)?.[1] ||
		pageUrl.match(/\/events\/([^/?#]+)/i)?.[1] ||
		null;

	// User walkthrough: span.evcal_desc[data-location_address]
	const locAddress =
		html.match(/data-location_address=['"]([^'"]+)['"]/i)?.[1] || address;

	return [
		toPartnerEvent({
			title,
			starts_at: startsAt,
			ends_at: endsAt,
			venue_name: venueName,
			address: locAddress ?? address,
			description,
			image_url: imageUrl,
			source_url: pageUrl,
			source_partner: "eventon",
			source_event_id: sourceEventId
				? `eventon:${sourceEventId}#${startsAt}`
				: `eventon:${pageUrl}#${startsAt}`,
			raw_date_text: startRaw ?? startsAt,
			ticket_url: ticketUrl,
			confidence: 1,
		}),
	];
}

/** Prefer /calendar/ or Long Center upcoming-calendar when the configured URL is a thin shell. */
export function resolveEventOnCalendarPageUrl(calendarUrl: string, html: string): string {
	const origin = originOf(calendarUrl);
	if (/\/calendar\/?$/i.test(calendarUrl)) return calendarUrl;
	if (/\/upcoming-calendar\/?$/i.test(calendarUrl)) return calendarUrl;
	// If page already has EventON calendar shell, use it
	if (/ajde_evcal_calendar|evo_cal_data|id=['"]evcal_list['"]|id=['"]evcal_calendar_\d+['"]/i.test(html)) {
		return calendarUrl;
	}
	// Speakeasy-style: events archive is thin; real list is on /calendar/
	if (/speakeasyaustin\.com/i.test(calendarUrl)) {
		return new URL("/calendar/", origin).toString();
	}
	// Long Center: /events/ is archive; live list is /upcoming-calendar/
	if (/thelongcenter\.org/i.test(calendarUrl)) {
		return new URL("/upcoming-calendar/", origin).toString();
	}
	return calendarUrl;
}

/**
 * EventON 5+ exposes CPT via WP REST when calendar AJAX is REST-only / nonce-locked.
 * List posts, then detail pages supply JSON-LD startDate (Donn's Depot).
 */
export async function discoverEventUrlsFromWpRest(
	origin: string,
	maxUrls: number,
): Promise<string[]> {
	const urls: string[] = [];
	const seen = new Set<string>();
	const pageSize = Math.min(100, Math.max(20, maxUrls));
	for (let page = 1; page <= 5 && urls.length < maxUrls; page++) {
		const api = new URL("/wp-json/wp/v2/ajde_events", origin);
		api.searchParams.set("per_page", String(pageSize));
		api.searchParams.set("page", String(page));
		api.searchParams.set("orderby", "modified");
		api.searchParams.set("order", "desc");
		api.searchParams.set("status", "publish");
		try {
			const res = await fetch(api.toString(), {
				headers: {
					Accept: "application/json",
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				},
			});
			if (!res.ok) break;
			const rows = (await res.json()) as Array<{ link?: string; slug?: string }>;
			if (!Array.isArray(rows) || rows.length === 0) break;
			for (const row of rows) {
				const link = typeof row.link === "string" ? row.link : "";
				const n = normalizeEventUrl(link, origin);
				if (!n || seen.has(n)) continue;
				seen.add(n);
				urls.push(n);
				if (urls.length >= maxUrls) break;
			}
			if (rows.length < pageSize) break;
		} catch {
			break;
		}
	}
	return urls;
}

async function discoverEventUrlsFromSitemaps(
	origin: string,
	maxUrls: number,
): Promise<string[]> {
	const entries: { url: string; lastmod: number }[] = [];
	const seen = new Set<string>();
	let sitemapIndexXml = "";
	try {
		sitemapIndexXml = await fetchPageText(new URL("/sitemap_index.xml", origin).toString());
	} catch {
		return [];
	}
	const eventSitemaps = [
		...sitemapIndexXml.matchAll(/<loc>([^<]*ajde_events-sitemap[^<]*)<\/loc>/gi),
	].map((m) => m[1]!.trim());
	const toFetch =
		eventSitemaps.length > 0
			? eventSitemaps
			: [new URL("/ajde_events-sitemap1.xml", origin).toString()];

	for (const smUrl of toFetch) {
		try {
			const xml = await fetchPageText(smUrl);
			for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
				const loc = block[1]!.match(/<loc>([^<]+)<\/loc>/i)?.[1]?.trim();
				if (!loc) continue;
				const n = normalizeEventUrl(loc, origin);
				if (!n || seen.has(n)) continue;
				if (/\/events\/?$/i.test(n.replace(/\/$/, ""))) continue;
				seen.add(n);
				const lmRaw = block[1]!.match(/<lastmod>([^<]+)<\/lastmod>/i)?.[1];
				const lastmod = lmRaw ? Date.parse(lmRaw) : 0;
				entries.push({ url: n, lastmod: Number.isNaN(lastmod) ? 0 : lastmod });
			}
		} catch {
			// skip
		}
	}
	entries.sort((a, b) => b.lastmod - a.lastmod);
	const recencyCutoff = Date.now() - 200 * 24 * 60 * 60 * 1000;
	const recent = entries.filter((e) => e.lastmod >= recencyCutoff);
	const pool = recent.length >= 10 ? recent : entries;
	return pool.slice(0, maxUrls).map((e) => e.url);
}

export async function fetchEventOnEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead: number;
	maxEvents?: number;
}): Promise<PartnerEvent[]> {
	const maxEvents = params.maxEvents ?? 80;
	const now = Date.now() - 60 * 60 * 1000;
	const cutoff = Date.now() + params.scrapeDaysAhead * 24 * 60 * 60 * 1000;
	const origin = originOf(params.calendarUrl);

	// Resolve calendar page (Speakeasy: /calendar/ has #evcal_list + #evcal_next)
	let calUrl = resolveEventOnCalendarPageUrl(params.calendarUrl, params.calendarHtml);
	let calHtml = params.calendarHtml;
	if (calUrl !== params.calendarUrl) {
		try {
			calHtml = await fetchPageText(calUrl);
		} catch {
			calUrl = params.calendarUrl;
			calHtml = params.calendarHtml;
		}
	}

	// 1) Primary: calendar AJAX walkthrough (EventON classic)
	let discovered: string[] = [];
	try {
		discovered = await discoverEventUrlsFromCalendarAjax({
			calendarHtml: calHtml,
			calendarUrl: calUrl,
			scrapeDaysAhead: params.scrapeDaysAhead,
		});
	} catch {
		discovered = [];
	}

	// Static list links if already hydrated
	if (discovered.length === 0) {
		discovered = extractEventOnListUrls(calHtml, calUrl);
	}

	// 2) EventON 5: WP REST list of ajde_events (AJAX often nonce-fails / empty shell)
	if (discovered.length < 5) {
		try {
			const fromRest = await discoverEventUrlsFromWpRest(origin, maxEvents * 2);
			for (const u of fromRest) {
				if (!discovered.includes(u)) discovered.push(u);
			}
		} catch {
			// optional
		}
	}

	// 3) Fallback: RSS + light sitemap
	if (discovered.length < 5) {
		try {
			const rss = await fetchPageText(new URL("/events/feed/", origin).toString());
			for (const u of extractEventOnUrlsFromRss(rss, origin)) {
				if (!discovered.includes(u)) discovered.push(u);
			}
		} catch {
			// optional
		}
		try {
			const fromSm = await discoverEventUrlsFromSitemaps(origin, 40);
			for (const u of fromSm) {
				if (!discovered.includes(u)) discovered.push(u);
			}
		} catch {
			// optional
		}
	}

	const toFetch = discovered.slice(0, maxEvents * 2);
	const out: PartnerEvent[] = [];
	const seen = new Set<string>();

	// 0) JSON-LD on the calendar page itself (often empty for EventON 5 shells)
	for (const ev of partnerEventsFromJsonLdPage({
		html: calHtml,
		pageUrl: calUrl,
		venueName: params.venueName,
		address: params.address,
		timezone: params.timezone,
		nowMs: now,
		cutoffMs: cutoff,
	})) {
		const key = `${ev.title}|${ev.starts_at}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ev);
	}

	// 0b) Homepage JSON-LD — Donn's Depot keeps the live week here, not /event-schedule/
	if (out.length < 3) {
		try {
			const homeUrl = new URL("/", origin).toString();
			if (homeUrl.replace(/\/$/, "") !== calUrl.replace(/\/$/, "")) {
				const homeHtml = await fetchPageText(homeUrl);
				for (const ev of partnerEventsFromJsonLdPage({
					html: homeHtml,
					pageUrl: homeUrl,
					venueName: params.venueName,
					address: params.address,
					timezone: params.timezone,
					nowMs: now,
					cutoffMs: cutoff,
				})) {
					const key = `${ev.title}|${ev.starts_at}`;
					if (seen.has(key)) continue;
					seen.add(key);
					out.push(ev);
				}
			}
		} catch {
			// optional
		}
	}

	// Walkthrough: for each list URL → open detail → extract fields → next
	for (let i = 0; i < toFetch.length; i++) {
		if (out.length >= maxEvents) break;
		const url = toFetch[i]!;
		try {
			const html = await fetchPageText(url);
			const events = await parseEventOnDetailPage({
				html,
				pageUrl: url,
				venueName: params.venueName,
				address: params.address,
				timezone: params.timezone,
			});
			for (const e of events) {
				const t = Date.parse(e.starts_at);
				if (Number.isNaN(t) || t < now || t > cutoff) continue;
				const key = `${e.title.toLowerCase()}|${e.starts_at}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(e);
			}
		} catch {
			// skip failed detail
		}
		await sleep(100);
	}

	out.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
	return out.slice(0, maxEvents);
}
