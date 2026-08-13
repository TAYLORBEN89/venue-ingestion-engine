/**
 * The White Horse (thewhitehorseaustin.com)
 *
 * Walkthrough (admin pilot):
 * 1. Homepage embeds Events Calendar (eventscalendar.co / Inffuse) in iframe
 *    #comp-kmmcqicx → plugin.eventscalendar.co/widget.html
 * 2. UI: .cl-calendar → .cl-view-week__events → .cl-event-list__event
 *    title: .cl-event-list__event__title
 *    date:  .cl-event-list__event__date
 *    day nav: .cl-view-week__navigation__days__day
 *    week nav: .cl-header__navigation__button (chevron)
 * 3. No images/descriptions on the widget — titles + times only.
 *
 * Structured feed (no browser):
 *   Google Calendar sync via Events Calendar broker:
 *   GET https://broker.eventscalendar.co/api/google/events
 *     ?user=user_…&project=proj_…&calendar=…@group.calendar.google.com
 *
 * Project/user/calendar IDs discovered from the live widget network calls
 * (stable per Wix site install).
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { fetchPageText } from "./fetch-page";

const ORIGIN = "https://www.thewhitehorseaustin.com";
const BROKER = "https://broker.eventscalendar.co/api/google/events";

/** Discovered from live widget (2026-07) — whitehorse confirmed shows GCal. */
const WHITE_HORSE_CALENDAR = {
	user: "user_VrArD1iWlMibcVpvljMTt",
	project: "proj_945OpCDVf4GE0sVN6favP",
	calendarId: "c6bl5p36vpushauid2vvf88muc@group.calendar.google.com",
};

export type WhiteHorseGcalEvent = {
	id?: string;
	title?: string;
	description?: string | null;
	location?: string | null;
	allday?: boolean;
	start?: number;
	end?: number;
	start_time?: string;
	end_time?: string;
	timezone?: string | null;
	source?: string;
};

/** Cover-charge calendar markers, not acts. */
const NOISE_TITLE =
	/^\$\d+(\.\d{2})?\s*cover\b|^cover\s*charge\b|^no\s*cover\b|^free\s*cover\b/i;

export function isWhiteHorse(pageUrl: string, html = ""): boolean {
	if (/thewhitehorseaustin\.com/i.test(pageUrl)) return true;
	// feed_url may be the broker Google sync (used as event_feed_url on the venue source)
	if (
		/broker\.eventscalendar\.co\/api\/google\/events/i.test(pageUrl) &&
		(/proj_945OpCDVf4GE0sVN6favP|user_VrArD1iWlMibcVpvljMTt|c6bl5p36vpushauid2vvf88muc/i.test(
			pageUrl,
		) ||
			/whitehorse/i.test(pageUrl))
	) {
		return true;
	}
	return (
		/thewhitehorseaustin\.com/i.test(html) &&
		(/eventscalendar\.co|cl-event-list__event|comp-kmmcqicx/i.test(html) ||
			/Events Calendar/i.test(html))
	);
}

function parseStartIso(raw: string | undefined, epochMs: number | undefined): string | null {
	if (raw) {
		const t = Date.parse(raw);
		if (!Number.isNaN(t)) return new Date(t).toISOString();
	}
	if (typeof epochMs === "number" && epochMs > 1e12) {
		return new Date(epochMs).toISOString();
	}
	if (typeof epochMs === "number" && epochMs > 1e9) {
		return new Date(epochMs * 1000).toISOString();
	}
	return null;
}

export function partnerEventFromWhiteHorseGcal(
	ev: WhiteHorseGcalEvent,
	params: { venueName: string; address: string | null },
): PartnerEvent | null {
	const title = String(ev.title || "")
		.replace(/\s+/g, " ")
		.trim();
	if (!title || title.length < 2) return null;
	if (NOISE_TITLE.test(title)) return null;

	const startsAt = parseStartIso(ev.start_time, ev.start);
	if (!startsAt) return null;

	let endsAt = parseStartIso(ev.end_time, ev.end);
	if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) endsAt = null;

	const sourceEventId = ev.id
		? `white-horse:${ev.id}`
		: `white-horse:${title}|${startsAt}`;

	return toPartnerEvent({
		title,
		starts_at: startsAt,
		ends_at: endsAt,
		venue_name: params.venueName,
		address: params.address,
		description: ev.description?.trim() ? String(ev.description).slice(0, 4000) : null,
		image_url: null,
		source_url: ORIGIN + "/",
		source_partner: "white_horse",
		source_event_id: sourceEventId,
		raw_date_text: ev.start_time || startsAt,
		price_text: null,
		ticket_url: ORIGIN + "/",
		confidence: 1,
	});
}

export async function fetchWhiteHorseGoogleEvents(params: {
	user?: string;
	project?: string;
	calendarId?: string;
}): Promise<{ events: WhiteHorseGcalEvent[]; timezone: string | null }> {
	const user = params.user || WHITE_HORSE_CALENDAR.user;
	const project = params.project || WHITE_HORSE_CALENDAR.project;
	const calendarId = params.calendarId || WHITE_HORSE_CALENDAR.calendarId;
	const url = `${BROKER}?user=${encodeURIComponent(user)}&project=${encodeURIComponent(project)}&calendar=${encodeURIComponent(calendarId)}`;

	const raw = await fetchPageText(url);
	const parsed = JSON.parse(raw) as {
		result?: boolean;
		events?: WhiteHorseGcalEvent[];
		timezone?: string | null;
	};
	return {
		events: Array.isArray(parsed.events) ? parsed.events : [],
		timezone: parsed.timezone ?? "America/Chicago",
	};
}

/**
 * Optionally discover project/user/calendar from public project data
 * (when feed_url is not set). Falls back to known White Horse IDs.
 */
export async function resolveWhiteHorseCalendarConfig(feedUrl?: string | null): Promise<{
	user: string;
	project: string;
	calendarId: string;
}> {
	if (feedUrl && /broker\.eventscalendar\.co\/api\/google\/events/i.test(feedUrl)) {
		const u = new URL(feedUrl);
		return {
			user: u.searchParams.get("user") || WHITE_HORSE_CALENDAR.user,
			project: u.searchParams.get("project") || WHITE_HORSE_CALENDAR.project,
			calendarId: u.searchParams.get("calendar") || WHITE_HORSE_CALENDAR.calendarId,
		};
	}
	return { ...WHITE_HORSE_CALENDAR };
}

export async function fetchWhiteHorseEvents(params: {
	calendarUrl?: string;
	feedUrl?: string | null;
	venueName: string;
	address: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
	maxEvents?: number;
	/** Keep cover-charge rows ($5 Cover) — default false. */
	includeCoverCharges?: boolean;
}): Promise<PartnerEvent[]> {
	const days = params.scrapeDaysAhead ?? 90;
	const maxEvents = params.maxEvents ?? 120;
	const now = Date.now() - 2 * 60 * 60 * 1000;
	const cutoff = Date.now() + days * 24 * 60 * 60 * 1000;

	const cfg = await resolveWhiteHorseCalendarConfig(params.feedUrl);
	const { events: raw } = await fetchWhiteHorseGoogleEvents(cfg);

	const out: PartnerEvent[] = [];
	const seen = new Set<string>();

	for (const row of raw) {
		if (!params.includeCoverCharges && NOISE_TITLE.test(String(row.title || ""))) continue;
		const ev = partnerEventFromWhiteHorseGcal(row, {
			venueName: params.venueName,
			address: params.address,
		});
		if (!ev) continue;
		const t = Date.parse(ev.starts_at);
		if (Number.isNaN(t) || t < now || t > cutoff) continue;
		const key = ev.source_event_id || `${ev.title}|${ev.starts_at}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ev);
	}

	// Full window first, then nearest shows — broker payload is not time-ordered.
	out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return out.slice(0, maxEvents);
}
