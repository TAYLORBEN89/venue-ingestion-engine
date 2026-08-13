const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const targets = [
	["hotel-home", "https://texashotelvegas.com/"],
	["hotel-events", "https://texashotelvegas.com/events/"],
	["hotel-calendar", "https://texashotelvegas.com/calendar/"],
	["hotel-shows", "https://texashotelvegas.com/shows/"],
	["meanwhile-events", "https://www.meanwhilebeer.com/events"],
	["meanwhile-home", "https://www.meanwhilebeer.com/"],
];

for (const [name, url] of targets) {
	try {
		const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
		const html = await res.text();
		console.log(`\n=== ${name} ${res.status} ${url} len=${html.length} ===`);
		const title = html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim();
		console.log("title:", title);

		const checks = [
			[/prekindle\.com\/api\/events\/organizer\/(\d+)/i, "prekindle-org"],
			[/prekindle/i, "prekindle-mention"],
			[/get_events_for_calendar/i, "event-discovery"],
			[/event-discovery/i, "event-discovery-plugin"],
			[/tribe-events|the-events-calendar/i, "tec"],
			[/eventon/i, "eventon"],
			[/\.ics|ical=1|text\/calendar/i, "ical"],
			[/bandsintown/i, "bandsintown"],
			[/eventbrite/i, "eventbrite"],
			[/squarespace/i, "squarespace"],
			[/website-files\.com|webflow/i, "webflow"],
			[/seatengine/i, "seatengine"],
			[/application\/ld\+json/i, "json-ld"],
			[/wp-content\/plugins/i, "wp-plugin"],
		];
		for (const [re, label] of checks) {
			const m = html.match(re);
			if (m) console.log(`  ${label}:`, m[0].slice(0, 120));
		}

		const eventHrefs = [
			...new Set(
				[...html.matchAll(/href=["']([^"']+)["']/gi)]
					.map((m) => m[1])
					.filter((h) => /event|show|calendar|concert|ticket/i.test(h)),
			),
		].slice(0, 12);
		if (eventHrefs.length) console.log("  event-ish hrefs:", eventHrefs);

		const jsonLd = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
		if (jsonLd.length) {
			for (const block of jsonLd.slice(0, 2)) {
				try {
					const parsed = JSON.parse(block[1].trim());
					const type = parsed["@type"] ?? parsed["@graph"]?.map((x) => x["@type"]).join(",");
					console.log("  json-ld type:", type);
					if (parsed["@graph"]) {
						const events = parsed["@graph"].filter((x) => /Event/i.test(x["@type"] ?? ""));
						console.log("  json-ld events:", events.length);
						if (events[0]) console.log("  sample:", events[0].name, events[0].startDate);
					}
				} catch {
					console.log("  json-ld: parse failed, len", block[1].length);
				}
			}
		}
	} catch (err) {
		console.log(`ERR ${name}:`, err.message);
	}
}

const detailUrls = [
	"https://www.meanwhilebeer.com/events/tuesday-trivia-73",
	"https://texashotelvegas.com/event/world-cup-2026-watch-parties-on-the-hotel-vegas-patio/",
];
for (const url of detailUrls) {
	const res = await fetch(url, { headers: { "User-Agent": UA } });
	const html = await res.text();
	console.log(`\n=== DETAIL ${res.status} ${url} ===`);
	console.log(
		"h1:",
		html
			.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
			?.replace(/<[^>]+>/g, "")
			.trim(),
	);
	const dates = [
		...html.matchAll(
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
		),
	].map((m) => m[0]);
	console.log("dates:", dates.slice(0, 5));
	const times = [...html.matchAll(/\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)/gi)].map((m) => m[0]);
	console.log("times:", times.slice(0, 5));
	const prek = html.match(/href=["'](https:\/\/www\.prekindle\.com\/event\/[^"']+)["']/i)?.[1];
	console.log("prekindle:", prek);
	const mecDate = html.match(/mec-event-date[^>]*>([\s\S]*?)<\//i)?.[1]?.replace(/<[^>]+>/g, " ").trim();
	console.log("mec-event-date:", mecDate);
	const mecTime = html.match(/mec-start-time[^>]*>([\s\S]*?)<\//i)?.[1]?.replace(/<[^>]+>/g, " ").trim();
	console.log("mec-start-time:", mecTime);
	const eventLinks = [...html.matchAll(/href=["']([^"']*\/event\/[^"']+)["']/gi)].map((m) => m[1]).slice(0, 5);
	console.log("event links on calendar sample n/a");
}