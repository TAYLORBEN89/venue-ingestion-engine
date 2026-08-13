const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const html = await (await fetch("https://www.meanwhilebeer.com/events", { headers: { "User-Agent": UA } })).text();

// pagination
const pages = [...html.matchAll(/\?([a-f0-9]+)_page=(\d+)/gi)].map((m) => ({ id: m[1], page: Number(m[2]) }));
const pageId = pages[0]?.id;
const maxPage = Math.max(...pages.map((p) => p.page), 1);
console.log("pagination id", pageId, "max linked page", maxPage);

const all = new Map();
for (let page = 1; page <= Math.max(maxPage + 1, 4); page++) {
	const url = page === 1 ? "https://www.meanwhilebeer.com/events" : `https://www.meanwhilebeer.com/events?${pageId}_page=${page}`;
	const body = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
	const slugs = [...new Set([...body.matchAll(/href=["']\/events\/([^"'#?]+)["']/gi)].map((m) => m[1]))];
	const dates = [...new Set([...body.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi)].map((m) => m[0]))];
	let newCount = 0;
	for (const s of slugs) {
		if (!all.has(s)) {
			all.set(s, page);
			newCount++;
		}
	}
	console.log(`page ${page}: slugs=${slugs.length} new=${newCount} dates=${dates[0]}..${dates.at(-1)}`);
	if (newCount === 0 && page > maxPage) break;
}

console.log("total unique slugs", all.size);

// month chevron - look for data attributes
const monthUi = html.match(/prev-action-btn|next-action-btn|calendar-month|w-dyn-list/i);
console.log("month UI hints:", monthUi?.[0]);
const scripts = html.match(/events\s*filter|month|chevron|calendar/gi)?.slice(0, 20);
console.log("script keywords", scripts);