const bases = [
	"https://antonesnightclub.com/",
	"https://antonesnightclub.com/calendar/",
	"https://moodyamphitheater.com/events-tickets",
	"https://mohawkaustin.com/shows",
];

const suffixes = ["?ical=1", "feed/ical/", "events/feed/", "?post_type=tribe_events&ical=1"];

for (const base of bases) {
	for (const suffix of suffixes) {
		const url = new URL(suffix, base).toString();
		try {
			const res = await fetch(url, {
				headers: { Accept: "text/calendar,text/html,*/*", "User-Agent": "Mozilla/5.0" },
			});
			const ct = res.headers.get("content-type") ?? "";
			const text = (await res.text()).slice(0, 120);
			if (res.ok && (ct.includes("calendar") || text.includes("BEGIN:VCALENDAR"))) {
				console.log("HIT", url, ct, text.replace(/\n/g, " ").slice(0, 80));
			}
		} catch {
			// skip
		}
	}
}