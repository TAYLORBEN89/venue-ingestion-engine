const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const html = await (
	await fetch(
		"https://texashotelvegas.com/all-events/action~agenda/cat_ids~2351/events_limit~50/request_format~html/",
		{ headers: { "User-Agent": UA } },
	)
).text();

const slug = "cory-hanson";
const idx = html.indexOf(slug);
console.log("idx", idx);
if (idx >= 0) {
	const chunk = html.slice(Math.max(0, idx - 500), idx + 1200);
	console.log(chunk.replace(/\s+/g, " ").slice(0, 2000));
}

// count how many page_offset links in calendar page
const cal = await (await fetch("https://texashotelvegas.com/calendar/", { headers: { "User-Agent": UA } })).text();
const offsets = [...cal.matchAll(/page_offset~(-?\d+)/gi)].map((m) => m[1]);
console.log("\npage_offsets in calendar:", [...new Set(offsets)]);