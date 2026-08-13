const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function slugs(html) {
	return [...new Set([...html.matchAll(/event(?:&#x2F;|\/)([a-z0-9-]+)/gi)].map((m) => m[1]))];
}

const cal = await (await fetch("https://texashotelvegas.com/calendar/", { headers: { "User-Agent": UA } })).text();
const navLinks = [
	...new Set(
		[...cal.matchAll(/href=["']([^"']*\/all-events\/[^"']*)["']/gi)].map((m) =>
			m[1].replace(/&#x2F;/g, "/").replace(/&#x7E;/g, "~").replace(/&amp;/g, "&"),
		),
	),
].filter((u) => /page_offset|exact_date|month|agenda/i.test(u));

console.log("nav links from calendar:", navLinks.length);
for (const u of navLinks.slice(0, 20)) console.log(" ", u);

const catId = "2351";
const now = new Date();
const monthUrls = [];
for (let offset = -1; offset <= 4; offset++) {
	const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	monthUrls.push(
		`https://texashotelvegas.com/all-events/action~month/time~${y}-${m}-01/cat_ids~${catId}/events_limit~50/request_format~html/`,
		`https://texashotelvegas.com/all-events/action~agenda/page_offset~${offset}/cat_ids~${catId}/events_limit~50/request_format~html/`,
	);
}

const allSlugs = new Set();
for (const url of monthUrls) {
	const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
	const s = slugs(html);
	for (const x of s) allSlugs.add(x);
	if (s.length) console.log(`\n${s.length} slugs from ${url.replace("https://texashotelvegas.com", "")}`);
}

console.log("\nunion across month probes:", allSlugs.size);

// Meanwhile page 2
const p1 = await (await fetch("https://www.meanwhilebeer.com/events", { headers: { "User-Agent": UA } })).text();
const p2 = await (await fetch("https://www.meanwhilebeer.com/events?b93eb246_page=2", { headers: { "User-Agent": UA } })).text();
const s1 = [...new Set([...p1.matchAll(/href=["']\/events\/([^"'#?]+)["']/gi)].map((m) => m[1]))];
const s2 = [...new Set([...p2.matchAll(/href=["']\/events\/([^"'#?]+)["']/gi)].map((m) => m[1]))];
const dates1 = [...new Set([...p1.matchAll(/(July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi)].map((m) => m[0]))];
const dates2 = [...new Set([...p2.matchAll(/(July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi)].map((m) => m[0]))];
console.log("\nMeanwhile page1 slugs", s1.length, "dates", dates1);
console.log("Meanwhile page2 slugs", s2.length, "dates", dates2);
console.log("new on page2:", s2.filter((s) => !s1.includes(s)).slice(0, 10));