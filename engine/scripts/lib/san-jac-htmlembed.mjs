/**
 * San Jac Saloon — Google Calendar classic htmlembed agenda parser.
 *
 * Why not basic.ics?
 *   Public ICS is incomplete vs the embed UI. Example Jul 17, 2026:
 *     UI / htmlembed: 3pm Aaron Navarro Duo · 6:30pm Ben Cina · 10pm Aaron Navarro Band
 *     basic.ics: only Ben Cina
 *
 * Page: https://www.sanjacsaloon.com/events
 *   iframe 1: src=sanjacsaloon@gmail.com          (SJS Shows / downstairs)
 *   iframe 2: src=mfgm3bii…@group.calendar.google.com (upstairs)
 *
 * New SPA embed DOM (what you see when inspecting the live iframe):
 *   date cell:  data-datekey / <h2 class="w48V4c">17</h2>
 *   event line: <span class="XuJrye">3pm to 6pm, Aaron Navarro Duo, Calendar: SJS Shows, …</span>
 *   short line: <span class="DvyQhe">10pm</span><span class="WBi6vc">Aaron Navarro Band</span>
 *
 * Machine scrape (classic htmlembed — same events, static HTML):
 *   https://calendar.google.com/calendar/htmlembed?src=…&ctz=America/Chicago&mode=AGENDA&dates=YYYYMMDD/YYYYMMDD
 *   Structure:
 *     <div class="date">Fri Jul 17, 2026</div>
 *     <table class="events">
 *       <tr class="event"><td class="event-time">3pm</td>
 *         …<span class="event-summary">Aaron Navarro Duo</span>
 *
 * Month navigation in SPA embed = chevrons; for scrape we request each month via &dates=.
 */

export const SAN_JAC_PAGE = "https://www.sanjacsaloon.com/events";

export const SAN_JAC_CALENDARS = [
	{
		key: "downstairs",
		label: "SJS Shows (downstairs)",
		src: "sanjacsaloon@gmail.com",
		srcEncoded: "sanjacsaloon%40gmail.com",
		embed: "https://calendar.google.com/calendar/embed?src=sanjacsaloon%40gmail.com&ctz=America%2FChicago",
	},
	{
		key: "upstairs",
		label: "Upstairs / Jack's Room",
		src: "mfgm3bii42jvfbluljkje8p2b0@group.calendar.google.com",
		srcEncoded: "mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com",
		embed:
			"https://calendar.google.com/calendar/embed?src=mfgm3bii42jvfbluljkje8p2b0%40group.calendar.google.com&ctz=America%2FChicago",
	},
];

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Format Date → YYYYMMDD in America/Chicago (for dates= param). */
export function chicagoYmd(d) {
	return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }).replace(/-/g, "");
}

/** Parse "Fri Jul 17, 2026" → { y, m, d, isoDate: YYYY-MM-DD } */
export function parseAgendaDateLabel(label) {
	const t = String(label || "").replace(/\s+/g, " ").trim();
	// Fri Jul 17, 2026
	const m = t.match(
		/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})/i,
	);
	if (!m) return null;
	const months = {
		jan: 1,
		feb: 2,
		mar: 3,
		apr: 4,
		may: 5,
		jun: 6,
		jul: 7,
		aug: 8,
		sep: 9,
		oct: 10,
		nov: 11,
		dec: 12,
	};
	const mo = months[m[1].toLowerCase().slice(0, 3)];
	const day = Number(m[2]);
	const year = Number(m[3]);
	if (!mo || !day || !year) return null;
	const isoDate = `${year}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	return { year, month: mo, day, isoDate, label: t };
}

/**
 * Parse "3pm", "6:30pm", "12pm", "10pm" → { hour24, minute }
 */
export function parseAgendaTime(timeStr) {
	const t = String(timeStr || "").trim().toLowerCase();
	const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
	if (!m) return null;
	let hour = Number(m[1]);
	const minute = m[2] ? Number(m[2]) : 0;
	const ap = m[3].toLowerCase();
	if (ap === "pm" && hour < 12) hour += 12;
	if (ap === "am" && hour === 12) hour = 0;
	return { hour24: hour, minute };
}

/** Build Chicago local ISO-ish instant as UTC ISO for storage. */
export function chicagoLocalToIso(isoDate, hour24, minute) {
	// Store as America/Chicago wall time with offset -05:00 (CDT) — pilot convention.
	// Good enough for listing; production ical path can refine.
	const hh = String(hour24).padStart(2, "0");
	const mm = String(minute).padStart(2, "0");
	return new Date(`${isoDate}T${hh}:${mm}:00-05:00`);
}

/**
 * Parse classic htmlembed agenda HTML → events[].
 * Matches structure:
 *   <div class="date">Fri Jul 17, 2026</div>
 *   <table class="events"><tr class="event">…
 */
export function parseHtmlembedAgenda(html, meta = {}) {
	const events = [];
	// Split by date-section / date headers
	const sections = html.split(/<div class="date-section[^"]*">/i);
	for (const section of sections) {
		const dateLabel = section
			.match(/<div class="date">([\s\S]*?)<\/div>/i)?.[1]
			?.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		const parsedDate = parseAgendaDateLabel(dateLabel || "");
		if (!parsedDate) continue;

		const table = section.match(/<table class="events">([\s\S]*?)<\/table>/i)?.[1] || section;
		const rows = [...table.matchAll(/<tr class="event">([\s\S]*?)<\/tr>/gi)];
		for (const row of rows) {
			const body = row[1];
			const timeRaw = body
				.match(/<td class="event-time">([\s\S]*?)<\/td>/i)?.[1]
				?.replace(/<[^>]+>/g, "")
				.trim();
			const title =
				body
					.match(/class="event-summary"[^>]*>([\s\S]*?)<\//i)?.[1]
					?.replace(/<[^>]+>/g, "")
					.replace(/\s+/g, " ")
					.trim() ||
				body
					.match(/<span class="event-summary">([\s\S]*?)<\/span>/i)?.[1]
					?.replace(/<[^>]+>/g, "")
					.replace(/\s+/g, " ")
					.trim();
			const eid = body.match(/[?&]eid=([^&"']+)/i)?.[1] || null;
			if (!title || !timeRaw) continue;
			const tm = parseAgendaTime(timeRaw);
			if (!tm) continue;
			const start = chicagoLocalToIso(parsedDate.isoDate, tm.hour24, tm.minute);
			// Default slot length 3h if no end in classic agenda (UI XuJrye often has "3pm to 6pm")
			const end = new Date(start.getTime() + 3 * 3600000);
			events.push({
				room: meta.room || null,
				calendarLabel: meta.calendarLabel || null,
				date_label: parsedDate.label,
				iso_date: parsedDate.isoDate,
				time_raw: timeRaw,
				artist: title,
				summary: title,
				starts_at: start.toISOString(),
				ends_at: end.toISOString(),
				google_eid: eid ? decodeURIComponent(eid) : null,
				source: "htmlembed_agenda",
			});
		}
	}
	return events;
}

export function htmlembedAgendaUrl(srcEncoded, startYmd, endYmd) {
	return `https://calendar.google.com/calendar/htmlembed?src=${srcEncoded}&ctz=America%2FChicago&mode=AGENDA&dates=${startYmd}%2F${endYmd}`;
}

/**
 * Fetch one agenda range for one calendar.
 */
export async function fetchAgendaRange(cal, startYmd, endYmd, { retries = 5 } = {}) {
	const url = htmlembedAgendaUrl(cal.srcEncoded, startYmd, endYmd);
	let lastErr = null;
	for (let attempt = 0; attempt < retries; attempt++) {
		if (attempt > 0) {
			const wait = 2500 * attempt + Math.floor(Math.random() * 800);
			await new Promise((r) => setTimeout(r, wait));
		}
		const res = await fetch(url, {
			headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
		});
		const html = await res.text();
		if (res.status === 429 || res.status === 503) {
			lastErr = new Error(`htmlembed ${res.status} ${url}`);
			continue;
		}
		if (!res.ok) {
			throw new Error(`htmlembed ${res.status} ${url}`);
		}
		const events = parseHtmlembedAgenda(html, {
			room: cal.key,
			calendarLabel: cal.label,
		});
		return { url, status: res.status, bytes: html.length, events };
	}
	throw lastErr || new Error(`htmlembed failed ${url}`);
}

/**
 * Month iterator: first of month → first of next month as YYYYMMDD.
 */
export function* monthRanges(fromDate, monthCount) {
	const start = new Date(fromDate);
	// Chicago year/month
	const parts = start
		.toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
		.split("-")
		.map(Number);
	let y = parts[0];
	let m = parts[1];
	for (let i = 0; i < monthCount; i++) {
		const startYmd = `${y}${String(m).padStart(2, "0")}01`;
		let ny = y;
		let nm = m + 1;
		if (nm > 12) {
			nm = 1;
			ny += 1;
		}
		const endYmd = `${ny}${String(nm).padStart(2, "0")}01`;
		yield { y, m, startYmd, endYmd };
		y = ny;
		m = nm;
	}
}

/**
 * Full scrape: both calendars, monthCount months ahead from today (default 12).
 * Pilot: monthCount = 1.
 */
export async function scrapeSanJac({ monthCount = 1, fromDate = new Date() } = {}) {
	const all = [];
	const diagnostics = [];
	for (const cal of SAN_JAC_CALENDARS) {
		for (const range of monthRanges(fromDate, monthCount)) {
			const result = await fetchAgendaRange(cal, range.startYmd, range.endYmd);
			diagnostics.push({
				room: cal.key,
				month: `${range.y}-${String(range.m).padStart(2, "0")}`,
				url: result.url,
				status: result.status,
				bytes: result.bytes,
				events: result.events.length,
			});
			all.push(...result.events);
			// be polite to Google (avoid 429)
			await new Promise((r) => setTimeout(r, 800));
		}
	}
	// Dedupe by room+starts+artist
	const seen = new Set();
	const unique = [];
	for (const e of all) {
		const k = `${e.room}|${e.starts_at}|${e.artist}`;
		if (seen.has(k)) continue;
		seen.add(k);
		unique.push(e);
	}
	unique.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
	return { events: unique, diagnostics };
}

export function isNoiseArtist(name) {
	const t = String(name || "").trim().toLowerCase();
	if (!t || t.length < 2) return true;
	if (/^\(empty\)$|^empty$|^\(no summary\)$/i.test(t)) return true;
	if (/^(closed|private|tbd|tba|open|showx|busy|hours|happy hour|new event|meeting)$/i.test(t))
		return true;
	return false;
}
