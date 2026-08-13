/**
 * Outhouse Tickets venue pages (Poodie's Hilltop Roadhouse et al.).
 *
 * UI walkthrough (SPA grid on /venues/{slug}):
 *   div.grid.md:grid-cols-2.lg:grid-cols-3
 *     a[href="/events/{event-slug}/tickets"]  → ticket + event URL
 *     img (cloudinary)                        → flyer
 *     h3.font-bold                            → title
 *     p.font-medium                           → date / time
 *
 * Implementation: public Supabase REST used by outhousetickets.com SPA
 * (organizer_slug = venue path segment). More reliable than browser on SPA shell.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";

/** Public anon key shipped in Outhouse SPA (client-side). */
const OUTHOUSE_SUPABASE_URL = "https://qstsquwlpndagycsrozv.supabase.co";
const OUTHOUSE_ANON_KEY =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzdHNxdXdscG5kYWd5Y3Nyb3p2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0NDUwMzksImV4cCI6MjA4NzAyMTAzOX0.Rz-jrKdoRgvbDVwlrb1hmLSB6ZnJ5Com-AhKvUqYYP4";

export function isOuthouseTicketsCalendar(html: string, pageUrl: string): boolean {
	const hay = `${pageUrl}\n${html}`;
	return /outhousetickets\.com/i.test(hay);
}

/** Extract organizer slug from /venues/{slug} or query. */
export function extractOuthouseVenueSlug(pageUrl: string): string | null {
	const m =
		pageUrl.match(/outhousetickets\.com\/venues\/([a-z0-9-]+)/i) ||
		pageUrl.match(/[?&]venue=([a-z0-9-]+)/i);
	return m?.[1]?.toLowerCase() ?? null;
}

function stripHtml(html: string | null | undefined): string | null {
	if (!html) return null;
	const t = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<\/h\d>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#039;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
	return t.length >= 3 ? t : null;
}

function parseClock12(text: string): string | null {
	const m = text.replace(/\u202f/g, " ").match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
	if (!m) return null;
	let h = Number(m[1]);
	const min = Number(m[2]);
	const ap = m[3].toUpperCase();
	if (ap === "PM" && h < 12) h += 12;
	if (ap === "AM" && h === 12) h = 0;
	return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

/** date "2026-07-17" + time "08:00 PM" → local wall clock */
function toStartLocal(date: string, time: string | null | undefined): string | null {
	const ymd = (date || "").slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
	const clock = time ? parseClock12(time) : "20:00:00";
	if (!clock) return null;
	return `${ymd} ${clock}`;
}

type OuthouseEventRow = {
	id: string;
	slug: string;
	title: string;
	description?: string | null;
	summary_html?: string | null;
	date: string;
	time?: string | null;
	end_date?: string | null;
	end_time?: string | null;
	image_url?: string | null;
	poster_url?: string | null;
	ticket_url?: string | null;
	status?: string | null;
	organizer_slug?: string | null;
};

async function fetchOuthouseAnonKey(): Promise<string> {
	// Prefer live SPA key if still valid; fall back to known public key
	try {
		const res = await fetch("https://outhousetickets.com/", {
			headers: { "User-Agent": "HeyAustinBot/1.0" },
		});
		const html = await res.text();
		const asset = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
		if (asset) {
			const js = await (await fetch(`https://outhousetickets.com${asset}`)).text();
			const key = js.match(
				/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,
			)?.[0];
			if (key) return key;
		}
	} catch {
		/* use fallback */
	}
	return OUTHOUSE_ANON_KEY;
}

export async function fetchOuthouseTicketsEvents(params: {
	calendarUrl: string;
	venueName: string;
	address?: string | null;
	timezone?: string;
	scrapeDaysAhead?: number;
	/** Override organizer slug (defaults to path segment) */
	organizerSlug?: string | null;
}): Promise<PartnerEvent[]> {
	const {
		calendarUrl,
		venueName,
		address = null,
		timezone = "America/Chicago",
		scrapeDaysAhead = 120,
		organizerSlug: slugOverride,
	} = params;

	const organizerSlug = (slugOverride || extractOuthouseVenueSlug(calendarUrl) || "").toLowerCase();
	if (!organizerSlug) {
		throw new Error(`Outhouse Tickets: could not parse venue slug from ${calendarUrl}`);
	}

	const key = await fetchOuthouseAnonKey();
	const horizon = new Date();
	horizon.setDate(horizon.getDate() - 1);
	const fromDate = horizon.toISOString().slice(0, 10);
	const to = new Date();
	to.setDate(to.getDate() + scrapeDaysAhead);
	const toDate = to.toISOString().slice(0, 10);

	const qs = new URLSearchParams({
		select:
			"id,slug,title,description,summary_html,date,time,end_date,end_time,image_url,poster_url,ticket_url,status,organizer_slug",
		organizer_slug: `eq.${organizerSlug}`,
		date: `gte.${fromDate}`,
		order: "date.asc",
		limit: "200",
	});
	// PostgREST uses date=gte. separately — rebuild filter style
	const url =
		`${OUTHOUSE_SUPABASE_URL}/rest/v1/events?` +
		`select=id,slug,title,description,summary_html,date,time,end_date,end_time,image_url,poster_url,ticket_url,status,organizer_slug` +
		`&organizer_slug=eq.${encodeURIComponent(organizerSlug)}` +
		`&date=gte.${fromDate}` +
		`&date=lte.${toDate}` +
		`&order=date.asc&limit=200`;

	const res = await fetch(url, {
		headers: {
			apikey: key,
			Authorization: `Bearer ${key}`,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Outhouse Supabase ${res.status}: ${body.slice(0, 200)}`);
	}
	const rows = (await res.json()) as OuthouseEventRow[];
	const events: PartnerEvent[] = [];
	const seen = new Set<string>();
	const pastFloor = Date.now() - 12 * 60 * 60 * 1000;
	const cutoff = Date.now() + scrapeDaysAhead * 24 * 60 * 60 * 1000;

	for (const row of rows ?? []) {
		if (row.status && /cancel|draft|template/i.test(row.status)) continue;
		if (/template/i.test(row.title || "")) continue;
		if (/^cancelled\b/i.test(row.title || "")) continue;

		const startLocal = toStartLocal(row.date, row.time);
		if (!startLocal) continue;

		let startsAt: string;
		let endsAt: string | null = null;
		try {
			startsAt = localWallTimeToUtcIso(startLocal, timezone);
			if (row.end_date && row.end_time) {
				const endLocal = toStartLocal(row.end_date, row.end_time);
				if (endLocal) endsAt = localWallTimeToUtcIso(endLocal, timezone);
			}
		} catch {
			continue;
		}

		const t = new Date(startsAt).getTime();
		if (Number.isNaN(t) || t < pastFloor || t > cutoff) continue;

		const title = (row.title || "").trim();
		if (!title) continue;

		// Prefer marketing site ticket path from walkthrough; fall back to partner ticket_url
		const listingTicket = row.slug
			? `https://outhousetickets.com/events/${row.slug}/tickets`
			: null;
		const ticketUrl = listingTicket || row.ticket_url || null;
		const sourceUrl = listingTicket
			? `https://outhousetickets.com/events/${row.slug}`
			: row.ticket_url || calendarUrl;

		const imageUrl = row.image_url || row.poster_url || null;
		const description =
			stripHtml(row.description) || stripHtml(row.summary_html) || null;

		const sourceEventId = `outhouse:${row.id}`;
		if (seen.has(sourceEventId)) continue;
		seen.add(sourceEventId);

		events.push(
			toPartnerEvent({
				title,
				starts_at: startsAt,
				ends_at: endsAt,
				venue_name: venueName,
				address,
				description,
				image_url: imageUrl,
				source_url: sourceUrl,
				source_partner: "outhousetickets",
				source_event_id: sourceEventId,
				raw_date_text: [row.date, row.time].filter(Boolean).join(" "),
				price_text: null,
				ticket_url: ticketUrl,
				confidence: 0.96,
			}),
		);
	}

	return events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
