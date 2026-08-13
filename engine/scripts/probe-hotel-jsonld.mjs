const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const urls = [
	"https://texashotelvegas.com/event/cory-hanson/",
	"https://texashotelvegas.com/event/world-cup-2026-watch-parties-on-the-hotel-vegas-patio/",
];

for (const url of urls) {
	const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
	const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
	for (const b of blocks) {
		try {
			const parsed = JSON.parse(b[1].trim());
			const graph = parsed["@graph"] ?? [parsed];
			const events = graph.filter((n) => /Event/i.test(n["@type"] ?? ""));
			console.log("\n", url);
			console.log("events in json-ld:", events.length);
			for (const e of events.slice(0, 5)) {
				console.log({ name: e.name, start: e.startDate, end: e.endDate, url: e.url });
			}
			if (!events.length) {
				const types = graph.map((n) => n["@type"]).filter(Boolean);
				console.log("graph types:", types);
			}
		} catch (err) {
			console.log("parse err", err.message);
		}
	}
}