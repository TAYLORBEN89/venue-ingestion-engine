const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchText(url) {
	const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
	return { status: res.status, html: await res.text(), url: res.url };
}

function countSlugs(html, pattern) {
	return [...new Set([...html.matchAll(pattern)].map((m) => m[1]))].length;
}

console.log("=== Hotel Vegas MEC ===");
const hotelCal = await fetchText("https://texashotelvegas.com/calendar/");
const agendaDefault = hotelCal.html.match(
	/href=["']([^"']*\/all-events\/[^"']*action~agenda[^"']*)["']/gi,
)?.[0];
console.log("calendar len", hotelCal.html.length);
console.log("agenda links found:", [
	...new Set(
		[...hotelCal.html.matchAll(/href=["']([^"']*\/all-events\/[^"']*)["']/gi)].map((m) =>
			m[1].replace(/&#x2F;/g, "/").replace(/&#x7E;/g, "~").slice(0, 120),
		),
	),
].slice(0, 8));

const catId = hotelCal.html.match(/cat_ids~(\d+)/i)?.[1] ?? "2351";
const variants = [
	`https://texashotelvegas.com/all-events/action~agenda/cat_ids~${catId}/events_limit~10/request_format~html/`,
	`https://texashotelvegas.com/all-events/action~agenda/cat_ids~${catId}/events_limit~50/request_format~html/`,
	`https://texashotelvegas.com/all-events/action~agenda/cat_ids~${catId}/events_limit~200/request_format~html/`,
	`https://texashotelvegas.com/all-events/action~month/cat_ids~${catId}/events_limit~50/request_format~html/`,
	`https://texashotelvegas.com/all-events/action~agenda/page_offset~0/cat_ids~${catId}/events_limit~50/request_format~html/`,
	`https://texashotelvegas.com/all-events/action~agenda/page_offset~1/cat_ids~${catId}/events_limit~50/request_format~html/`,
	`https://texashotelvegas.com/all-events/action~agenda/page_offset~2/cat_ids~${catId}/events_limit~50/request_format~html/`,
];

for (const url of variants) {
	const { html, status } = await fetchText(url);
	const slugs = countSlugs(html, /event(?:&#x2F;|\/)([a-z0-9-]+)/gi);
	const dates = [
		...new Set(
			[...html.matchAll(
				/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
			)].map((m) => m[0]),
		),
	].slice(0, 6);
	console.log(`\n${status} slugs=${slugs} dates=${dates.join("; ") || "none"}`);
	console.log(" ", url.replace("https://texashotelvegas.com", ""));
}

console.log("\n=== Meanwhile Webflow ===");
const mw = await fetchText("https://www.meanwhilebeer.com/events");
const mwSlugs = countSlugs(mw.html, /href=["']\/events\/([^"'#?]+)["']/gi);
const mwDates = [
	...new Set(
		[...mw.html.matchAll(
			/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
		)].map((m) => m[0]),
	),
];
console.log("listing slugs:", mwSlugs);
console.log("listing dates:", mwDates);
console.log("pagination hints:", [
	...new Set(
		[...mw.html.matchAll(/href=["']([^"']+)["']/gi)]
			.map((m) => m[1])
			.filter((h) => /page|offset|month|next|prev|chevron|calendar/i.test(h)),
	),
].slice(0, 15));

// Check if webflow loads via API
const apiHints = [...mw.html.matchAll(/https:\/\/[^"'\s]+/gi)]
	.map((m) => m[0])
	.filter((u) => /cms|collection|api|events/i.test(u))
	.slice(0, 10);
console.log("api hints:", apiHints);