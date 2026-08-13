const targets = [
	["mohawk", "https://mohawkaustin.com/shows"],
	["moody-amp", "https://moodyamphitheater.com/events-tickets"],
	["hotel-vegas", "https://texashotelvegas.com/"],
	["stubbs", "https://stubbsaustin.com/concert-calendar/"],
];

for (const [name, url] of targets) {
	const res = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
	});
	const html = await res.text();
	console.log(`\n${name} ${res.status} len=${html.length}`);
	const patterns = [
		[/prekindle\.com[^"'\s]*/gi, "prekindle-url"],
		[/api\.prekindle[^"'\s]*/gi, "prekindle-api"],
		[/seatengine[^"'\s]*/gi, "seatengine"],
		[/get_events_for_calendar/gi, "event-discovery"],
		[/webflow/gi, "webflow"],
		[/application\/ld\+json/gi, "json-ld"],
		[/\.ics|ical=1/gi, "ical"],
	];
	for (const [re, label] of patterns) {
		const m = html.match(re);
		if (m) console.log(`  ${label}:`, [...new Set(m)].slice(0, 3));
	}
	const scriptSrc = [...html.matchAll(/src=["']([^"']+)["']/gi)]
		.map((x) => x[1])
		.filter((s) => /prekindle|seatengine|event|calendar/i.test(s))
		.slice(0, 5);
	if (scriptSrc.length) console.log("  scripts:", scriptSrc);
}