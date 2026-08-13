const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const urls = [
	"https://texashotelvegas.com/event/world-cup-2026-watch-parties-on-the-hotel-vegas-patio/",
	"https://texashotelvegas.com/event/cory-hanson/",
];

for (const url of urls) {
	const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
	console.log("\n===", url, "===");
	console.log("h1:", html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim());

	const occurrenceBlocks = [...html.matchAll(/class=["'][^"']*mec-event-occurrence[^"']*["'][\s\S]{0,500}/gi)].slice(0, 3);
	console.log("occurrence blocks:", occurrenceBlocks.length);

	const dateTimePairs = [];
	const dateMatches = [...html.matchAll(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/gi,
	)];
	const timeMatches = [...html.matchAll(/(\d{1,2}):(\d{2})\s*(am|pm)/gi)];
	console.log("dates:", dateMatches.map((m) => m[0]));
	console.log("times:", timeMatches.map((m) => m[0]));

	// look for mec schema
	const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
		.map((m) => m[1])
		.filter((s) => /mec|event|date/i.test(s) && s.length < 5000);
	for (const s of scripts.slice(0, 3)) console.log("script snippet:", s.slice(0, 300).replace(/\s+/g, " "));

	const ticket = html.match(/href=["']([^"']+)["'][^>]*>[\s\S]*?(?:ticket|buy)/i)?.[1];
	console.log("ticket?", ticket?.slice(0, 80));
}