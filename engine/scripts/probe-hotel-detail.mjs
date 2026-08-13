const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const agendaUrl =
	"https://texashotelvegas.com/all-events/action~agenda/cat_ids~2351/events_limit~50/request_format~html/";
const agendaHtml = await (await fetch(agendaUrl, { headers: { "User-Agent": UA } })).text();

function decodeEntities(s) {
	return s
		.replace(/&#x2F;/gi, "/")
		.replace(/&#x3A;/gi, ":")
		.replace(/&amp;/gi, "&");
}

const slugs = [
	...new Set(
		[...agendaHtml.matchAll(/event&#x2F;([a-z0-9-]+)/gi)].map((m) => m[1]),
	),
];
console.log("encoded slugs:", slugs.length);
console.log(slugs.slice(0, 15).join("\n"));

const url = `https://texashotelvegas.com/event/${slugs[0]}/`;
const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
console.log("\nDetail URL:", url);
console.log("h1:", html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim());

const patterns = [
	/mec-start-date[^>]*>([\s\S]*?)<\//i,
	/mec-start-time[^>]*>([\s\S]*?)<\//i,
	/mec-end-date[^>]*>([\s\S]*?)<\//i,
	/mec-end-time[^>]*>([\s\S]*?)<\//i,
	/<time[^>]+datetime=["']([^"']+)["']/i,
	/Date\s*:\s*([^<\n]+)/i,
	/Time\s*:\s*([^<\n]+)/i,
	/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
	/\d{1,2}:\d{2}\s*(?:am|pm)/i,
];
for (const re of patterns) {
	const m = html.match(re);
	if (m) console.log(re.source, "=>", (m[1] ?? m[0]).replace(/<[^>]+>/g, " ").trim().slice(0, 80));
}

// Check if instances/occurrences on detail page
const instanceLinks = [...html.matchAll(/instance_id=(\d+)/gi)].map((m) => m[1]);
console.log("instance_ids:", [...new Set(instanceLinks)].slice(0, 10));