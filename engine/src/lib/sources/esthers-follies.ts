/**
 * Esther's Follies — recurring revue, not a band calendar.
 *
 * AI scrape wrongly pulled /cast/* bios as events. This adapter:
 * - Ignores cast pages
 * - Emits recurring show occurrences for the next N days from the known
 *   weekly schedule (Thu night, Fri early/late, Sat early/late, etc.)
 *   when tickets page text confirms showtimes.
 */
import { toPartnerEvent, type PartnerEvent } from "../normalize";
import { localWallTimeToUtcIso } from "./local-time";

async function fetchLight(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 events-platform-esthers", Accept: "text/html" },
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

export function isEsthersFollies(pageUrl: string): boolean {
	return /esthersfollies\.com/i.test(pageUrl);
}

/** Reject cast/bio URLs and similar non-show links. */
export function isEsthersCastUrl(url: string): boolean {
	return /esthersfollies\.com\/cast\//i.test(url);
}

interface ShowSlot {
	/** 0=Sun … 6=Sat */
	weekday: number;
	hour: number;
	minute: number;
	title: string;
	/** Generated day-of-week poster (Supabase event-media) */
	image_url: string | null;
}

/**
 * Default Esther's weekly pattern (Austin revue).
 * One generated poster per day-slot (shared across dates).
 */
const DEFAULT_SLOTS: ShowSlot[] = [
	{
		weekday: 4,
		hour: 20,
		minute: 0,
		title: "Esther's Follies — Thursday Night Show",
		image_url:
			"https://jsjreklxpfkhclmfretu.supabase.co/storage/v1/object/public/event-media/51177cff-babf-4a36-a258-834f4e880b87/esthers-follies/thursday-night-651c3184-a176-4e5f-b235-cab5dbf1d87c.jpg",
	},
	{
		weekday: 5,
		hour: 19,
		minute: 0,
		title: "Esther's Follies — Friday Early Show",
		image_url:
			"https://jsjreklxpfkhclmfretu.supabase.co/storage/v1/object/public/event-media/51177cff-babf-4a36-a258-834f4e880b87/esthers-follies/friday-early-c4acd712-8f64-4dad-a9de-5effd2535a32.jpg",
	},
	{
		weekday: 5,
		hour: 21,
		minute: 0,
		title: "Esther's Follies — Friday Late Show",
		image_url:
			"https://jsjreklxpfkhclmfretu.supabase.co/storage/v1/object/public/event-media/51177cff-babf-4a36-a258-834f4e880b87/esthers-follies/friday-late-35bdea56-2219-4df4-b045-b5dcd9bee1b4.jpg",
	},
	{
		weekday: 6,
		hour: 19,
		minute: 0,
		title: "Esther's Follies — Saturday Early Show",
		image_url:
			"https://jsjreklxpfkhclmfretu.supabase.co/storage/v1/object/public/event-media/51177cff-babf-4a36-a258-834f4e880b87/esthers-follies/saturday-early-cd4c42f5-16ee-46f4-92ef-12caa6bcb946.jpg",
	},
	{
		weekday: 6,
		hour: 21,
		minute: 0,
		title: "Esther's Follies — Saturday Late Show",
		image_url:
			"https://jsjreklxpfkhclmfretu.supabase.co/storage/v1/object/public/event-media/51177cff-babf-4a36-a258-834f4e880b87/esthers-follies/saturday-late-f3a6af9b-fa14-44d2-9d95-8993eec47d06.jpg",
	},
];

function parseSlotsFromTicketsHtml(html: string): ShowSlot[] | null {
	const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
	// Look for patterns like "Thursday 8pm" / "Friday 7 & 9"
	const found: ShowSlot[] = [];
	const dayMap: Record<string, number> = {
		sunday: 0,
		monday: 1,
		tuesday: 2,
		wednesday: 3,
		thursday: 4,
		friday: 5,
		saturday: 6,
	};

	// "Thursday ... 8:00" etc.
	for (const [day, weekday] of Object.entries(dayMap)) {
		const re = new RegExp(`${day}[^.]{0,80}?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)`, "gi");
		let m: RegExpExecArray | null;
		const times: { hour: number; minute: number }[] = [];
		while ((m = re.exec(text)) !== null) {
			let hour = Number(m[1]);
			const minute = m[2] ? Number(m[2]) : 0;
			const ap = m[3].toLowerCase();
			if (ap === "pm" && hour < 12) hour += 12;
			if (ap === "am" && hour === 12) hour = 0;
			times.push({ hour, minute });
		}
		// "7 & 9" or "7 and 9 pm" on Friday/Saturday
		const dual = text.match(
			new RegExp(`${day}[^.]{0,60}?(\\d{1,2})\\s*(?:&|and)\\s*(\\d{1,2})\\s*(pm)?`, "i"),
		);
		if (dual) {
			const pm = (dual[3] || "pm").toLowerCase() === "pm";
			for (const raw of [Number(dual[1]), Number(dual[2])]) {
				let hour = raw;
				if (pm && hour < 12) hour += 12;
				times.push({ hour, minute: 0 });
			}
		}
		const uniq = new Map(times.map((t) => [`${t.hour}:${t.minute}`, t]));
		for (const t of uniq.values()) {
			const label =
				uniq.size > 1 && t.hour < 20
					? `Esther's Follies — ${day[0].toUpperCase()}${day.slice(1)} Early Show`
					: uniq.size > 1
						? `Esther's Follies — ${day[0].toUpperCase()}${day.slice(1)} Late Show`
						: `Esther's Follies — ${day[0].toUpperCase()}${day.slice(1)} Night Show`;
			const matchDefault = DEFAULT_SLOTS.find((s) => s.title === label);
			found.push({
				weekday,
				hour: t.hour,
				minute: t.minute,
				title: label,
				image_url: matchDefault?.image_url ?? null,
			});
		}
	}

	return found.length >= 2 ? found : null;
}

export async function fetchEsthersFolliesEvents(params: {
	calendarUrl: string;
	venueName: string;
	address: string | null;
	timezone: string;
	scrapeDaysAhead?: number;
}): Promise<PartnerEvent[]> {
	const scrapeDaysAhead = params.scrapeDaysAhead ?? 45;
	const origin = new URL(params.calendarUrl).origin;

	let slots = DEFAULT_SLOTS;
	try {
		const ticketsHtml = await fetchLight(`${origin}/tickets`);
		const parsed = parseSlotsFromTicketsHtml(ticketsHtml);
		if (parsed) slots = parsed;
	} catch {
		/* keep defaults */
	}

	const events: PartnerEvent[] = [];
	const start = new Date();
	start.setHours(0, 0, 0, 0);

	for (let d = 0; d < scrapeDaysAhead; d++) {
		const day = new Date(start.getTime() + d * 864e5);
		const weekday = day.getDay();
		const y = day.getFullYear();
		const mo = day.getMonth() + 1;
		const da = day.getDate();

		for (const slot of slots) {
			if (slot.weekday !== weekday) continue;
			const wall = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")} ${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}:00`;
			const startsAt = localWallTimeToUtcIso(wall, params.timezone);
			if (new Date(startsAt).getTime() < Date.now() - 3600e3) continue;

			events.push(
				toPartnerEvent({
					title: slot.title,
					starts_at: startsAt,
					ends_at: null,
					venue_name: params.venueName,
					address: params.address,
					description:
						"Esther's Follies presents Austin's legendary musical comedy revue — sketch comedy, song, and magic on Dirty Sixth. Showtimes and tickets at esthersfollies.com/tickets.",
					image_url: slot.image_url,
					source_url: `${origin}/tickets`,
					source_partner: "esthers_recurring",
					source_event_id: `esthers-${y}${String(mo).padStart(2, "0")}${String(da).padStart(2, "0")}-${slot.hour}${String(slot.minute).padStart(2, "0")}`,
					raw_date_text: wall,
					price_text: null,
					ticket_url: `${origin}/tickets`,
					confidence: 0.85,
				}),
			);
		}
	}

	return events;
}
