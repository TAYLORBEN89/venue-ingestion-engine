/**
 * Prekindle adapter (Hole in the Wall and other PK widgets).
 *
 * Walkthrough (HITW):
 *   1. Venue /shows page embeds #pk-cal-widget[data-org-id]
 *   2. Widget list = organizer API events (times + pk-title-link → promo)
 *   3. Promo page: flyer image, .description, buyLinks RSVP/checkout
 *
 * We use the organizer JSON API (same data as the list), then map promoId →
 * promo URL + checkout ticket URL to match the UI walkthrough.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";
import { fetchPageText } from "./fetch-page";

export interface PrekindleEvent {
	id: string;
	promoId?: string;
	title: string;
	headliner?: string;
	date: string;
	time?: string;
	doorsTime?: string;
	lineup?: string[];
	description?: string;
	price?: string;
	imageUrl?: string;
	dtfLinks?: string[];
	dtfNames?: string[];
	thirdPartyLink?: string;
	venue?: string;
	city?: string;
	state?: string;
}

export function isPrekindleCalendar(html: string, pageUrl: string): boolean {
	const hay = `${pageUrl}\n${html}`;
	return (
		/prekindle\.com/i.test(hay) ||
		/pk-cal-widget|pk-cal-loader|data-org-id/i.test(html) ||
		// Mohawk: prekindle mohawk-widget + list-view / event/?id= SPA shell
		/mohawk-widget|list-view-item|reloadWidget/i.test(html) ||
		/theholeinthewallaustin\.com|mohawkaustin\.com/i.test(pageUrl)
	);
}

/** Organizer id from API URL or #pk-cal-widget data-org-id (HITW Squarespace embed). */
export function extractPrekindleOrganizerId(html: string): string | null {
	return (
		html.match(/prekindle\.com\/api\/events\/organizer\/(\d+)/i)?.[1] ||
		html.match(/id=["']pk-cal-widget["'][^>]*data-org-id=["'](\d+)["']/i)?.[1] ||
		html.match(/data-org-id=["'](\d+)["'][^>]*id=["']pk-cal-widget["']/i)?.[1] ||
		html.match(/data-org-id=["'](\d+)["']/i)?.[1] ||
		html.match(/organizerId["']?\s*[:=]\s*["']?(\d{6,})/i)?.[1] ||
		null
	);
}

function parsePrekindleLocalIso(date: string, time: string): string {
	const [month, day, year] = date.split("/").map(Number);
	const m = time.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
	if (!m) throw new Error(`Invalid prekindle time: ${time}`);
	let hour = Number(m[1]) % 12;
	if (m[3]!.toLowerCase() === "pm") hour += 12;
	const minute = m[2]!;
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${minute}:00`;
}

function stripHtml(text: string | undefined): string | null {
	if (!text) return null;
	const plain = text
		.replace(/&nbsp;/gi, " ")
		.replace(/&rsquo;|&#8217;/gi, "'")
		.replace(/&ldquo;|&rdquo;/gi, '"')
		.replace(/&amp;/gi, "&")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > 0 ? plain.slice(0, 4000) : null;
}

function normalizeHttps(url: string | null | undefined): string | null {
	if (!url) return null;
	const u = url.replace(/&amp;/g, "&").trim();
	if (u.startsWith("//")) return `https:${u}`;
	if (u.startsWith("http://")) return `https://${u.slice("http://".length)}`;
	if (u.startsWith("/")) return `https://www.prekindle.com${u}`;
	if (u.startsWith("../")) {
		// e.g. ../checkout/id/-123 from promo page
		return `https://www.prekindle.com/${u.replace(/^\.\.\//, "")}`;
	}
	return u;
}

/** Promo page URL (walkthrough: pk-title-link → prekindle.com/promo/id/…). */
export function prekindlePromoUrl(event: PrekindleEvent): string | null {
	const fromDtf = event.dtfLinks?.find((l) => /prekindle\.com\/promo\/id\//i.test(l));
	if (fromDtf) return normalizeHttps(fromDtf);
	if (event.promoId) return `https://www.prekindle.com/promo/id/${event.promoId}`;
	if (event.id && /^-?\d+$/.test(event.id)) {
		// Sometimes id is event id not promo — still try promoId-shaped links first
		return null;
	}
	return null;
}

/** Checkout / ticket URL (walkthrough: RSVP HERE → checkout/id/{promoId}). */
export function prekindleTicketUrl(event: PrekindleEvent): string | null {
	if (event.thirdPartyLink) return normalizeHttps(event.thirdPartyLink);
	const promoId = event.promoId || event.dtfLinks?.[0]?.match(/promo\/id\/(-?\d+)/i)?.[1];
	if (promoId) return `https://www.prekindle.com/checkout/id/${promoId}`;
	const promo = prekindlePromoUrl(event);
	return promo;
}

/**
 * Optional promo-page enrich (flyer / RSVP href) when API media is thin.
 * Walkthrough selectors: img.flyer, span.pklinktext, div.description
 */
export async function enrichFromPrekindlePromo(
	promoUrl: string,
): Promise<{ image_url: string | null; ticket_url: string | null; description: string | null }> {
	try {
		const html = await fetchPageText(promoUrl);
		const image =
			html.match(
				/<img[^>]*class=["'][^"']*flyer[^"']*["'][^>]*src=["']([^"']+)["']/i,
			)?.[1] ||
			html.match(
				/src=["'](https:\/\/d1yf68t7nbxlyn\.cloudfront\.net\/image\/id\/[^"']+)["']/i,
			)?.[1] ||
			null;
		const buySection =
			html.match(/buyLinksListContainer[\s\S]{0,2500}/i)?.[0] ||
			html.match(/class=["']action-bar-button buybutton["'][\s\S]{0,400}/i)?.[0] ||
			"";
		let ticket: string | null = null;
		const buyHref = buySection.match(/href=["']([^"']+)["']/i)?.[1];
		if (buyHref) {
			ticket = normalizeHttps(
				buyHref.startsWith("http") || buyHref.startsWith("/") || buyHref.startsWith(".")
					? buyHref
					: null,
			);
			if (buyHref.startsWith("../") || buyHref.startsWith("/checkout")) {
				ticket = normalizeHttps(buyHref);
			} else if (buyHref.startsWith("http")) {
				ticket = normalizeHttps(buyHref);
			}
		}
		// Absolute checkout from relative
		if (ticket && ticket.includes("checkout/id/")) {
			// ok
		} else if (buyHref?.includes("checkout/id/")) {
			const id = buyHref.match(/checkout\/id\/(-?\d+)/i)?.[1];
			if (id) ticket = `https://www.prekindle.com/checkout/id/${id}`;
		}
		const desc =
			html.match(
				/class=["']description["'][^>]*wicketpath=["']body_description["'][^>]*>([\s\S]*?)<\/div>/i,
			)?.[1] ||
			html.match(/class=["']description["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
			null;
		return {
			image_url: image,
			ticket_url: ticket,
			description: stripHtml(desc ?? undefined),
		};
	} catch {
		return { image_url: null, ticket_url: null, description: null };
	}
}

export async function fetchPrekindleEvents(params: {
	calendarHtml: string;
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	organizerId?: string;
	/** When true, fetch each promo page for flyer/RSVP (slower; better media parity). */
	enrichPromoPages?: boolean;
	maxEnrich?: number;
}): Promise<PartnerEvent[]> {
	const organizerId = params.organizerId ?? extractPrekindleOrganizerId(params.calendarHtml);
	if (!organizerId) {
		throw new Error("Prekindle organizer ID not found on calendar page");
	}

	const apiUrl = `https://www.prekindle.com/api/events/organizer/${organizerId}?callback=widgetCallback`;
	const res = await fetch(apiUrl, {
		headers: {
			Accept: "*/*",
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Referer: params.calendarUrl,
		},
	});
	if (!res.ok) {
		throw new Error(`Prekindle API HTTP ${res.status}`);
	}

	const raw = await res.text();
	const jsonText = raw
		.replace(/^widgetCallback\(/, "")
		.replace(/^callback\(/, "")
		.replace(/\);?\s*$/, "");
	const payload = JSON.parse(jsonText) as { events?: PrekindleEvent[] };
	const events = payload.events ?? [];

	const out: PartnerEvent[] = [];
	const maxEnrich = params.maxEnrich ?? 40;
	let enriched = 0;

	for (const event of events) {
		let partner = toPrekindlePartnerEvent(event, params);
		if (!partner) continue;

		const promo = prekindlePromoUrl(event);
		const needsEnrich =
			params.enrichPromoPages !== false &&
			enriched < maxEnrich &&
			promo &&
			(!partner.image_url ||
				!partner.description ||
				partner.description.length < 40 ||
				!partner.ticket_url ||
				/\/promo\/id\//i.test(partner.ticket_url));

		if (needsEnrich && promo) {
			const extra = await enrichFromPrekindlePromo(promo);
			enriched++;
			partner = toPartnerEvent({
				title: partner.title,
				starts_at: partner.starts_at,
				ends_at: partner.ends_at,
				venue_name: partner.venue_name,
				address: partner.address,
				description: extra.description ?? partner.description,
				image_url: extra.image_url ?? partner.image_url,
				source_url: partner.source_url,
				source_partner: partner.source_partner,
				source_event_id: partner.source_event_id,
				raw_date_text: partner.raw_date_text,
				price_text: partner.price_text,
				ticket_url: extra.ticket_url ?? partner.ticket_url,
				confidence: partner.confidence,
			});
			// polite pacing
			await new Promise((r) => setTimeout(r, 80));
		}

		out.push(partner);
	}

	return out;
}

function toPrekindlePartnerEvent(
	event: PrekindleEvent,
	params: { calendarUrl: string; venueName: string; address: string | null; timezone: string },
): PartnerEvent | null {
	// Prefer full title; headliner/lineup is often incomplete
	const headliner = (event.headliner || event.lineup?.[0] || event.title || "").trim();
	const support = (event.lineup ?? [])
		.map((s) => String(s || "").trim())
		.filter((s) => s && s.toLowerCase() !== headliner.toLowerCase());
	const title = (event.title || headliner || "").trim();
	if (!title || !event.date || !event.time) return null;

	let startsAt: string;
	try {
		startsAt = localWallTimeToUtcIso(
			parsePrekindleLocalIso(event.date, event.time),
			params.timezone,
		);
	} catch {
		return null;
	}

	const promoUrl = prekindlePromoUrl(event);
	const ticketUrl = prekindleTicketUrl(event);
	// Mohawk walkthrough: list → mohawkaustin.com/event/?id={id} detail page
	const isMohawk = /mohawkaustin\.com/i.test(params.calendarUrl);
	const mohawkEventUrl =
		isMohawk && event.id
			? `https://mohawkaustin.com/event/?id=${encodeURIComponent(event.id)}`
			: null;
	const rawDateText = [
		event.date,
		event.doorsTime ? `doors ${event.doorsTime}` : null,
		event.time ? `show ${event.time}` : null,
		support.length ? `featuring ${support.join(", ")}` : null,
	]
		.filter(Boolean)
		.join(" · ");

	const priceNum = event.price != null ? Number(event.price) : NaN;
	const priceText = Number.isFinite(priceNum)
		? priceNum === 0
			? "Free / RSVP"
			: `$${event.price}`
		: event.price
			? `$${event.price}`
			: null;

	let description = stripHtml(event.description);
	if (support.length) {
		const feat = `Featuring ${support.join(", ")}.`;
		description = description ? `${feat} ${description}` : feat;
	}

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		venue_name: params.venueName,
		address: params.address,
		description,
		image_url: event.imageUrl ?? null,
		source_url: mohawkEventUrl ?? promoUrl ?? ticketUrl ?? params.calendarUrl,
		source_partner: "prekindle",
		source_event_id: event.promoId ?? event.id,
		raw_date_text: rawDateText,
		price_text: priceText,
		ticket_url: ticketUrl,
		confidence: 1,
	});
}
