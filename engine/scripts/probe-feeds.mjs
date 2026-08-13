const urls = [
	"https://antonesnightclub.com/calendar/",
	"https://moodyamphitheater.com/events-tickets",
	"https://mohawkaustin.com/shows",
	"https://texashotelvegas.com/events",
	"https://stubbsaustin.com/concert-calendar/",
];

for (const url of urls) {
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,*/*" },
		});
		const html = await res.text();
		const ical = html.match(/href=["']([^"']*(?:ical=1|feed\/ical|tribe\/events\/feed)[^"']*)["']/i);
		const link = html.match(/<link[^>]+type=["']text\/calendar["'][^>]+href=["']([^"']+)["']/i);
		console.log(url);
		console.log("  status", res.status, "len", html.length);
		console.log("  ical href", ical?.[1] ?? "—");
		console.log("  link rel", link?.[1] ?? "—");
		console.log("  TEC", /tribe-events|the-events-calendar/i.test(html));
	} catch (e) {
		console.log(url, "ERR", e.message);
	}
}