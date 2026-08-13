const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const url = "https://www.ticketmaster.com/event/3A00644DCA869362";
const res = await fetch(url, {
	headers: {
		"User-Agent": UA,
		Accept: "text/html,application/xhtml+xml",
		"Accept-Language": "en-US,en;q=0.9",
	},
	redirect: "follow",
});
const html = await res.text();
console.log("status", res.status, "len", html.length, "final", res.url);

const patterns = [
	[/ticketm\.net[^"'\s]*/gi, "ticketm"],
	[/EVENT_DETAIL_PAGE[^"'\s]*/gi, "EVENT_DETAIL"],
	[/og:image/gi, "og:image mentions"],
	[/"image"\s*:\s*"([^"]+)"/gi, "json image"],
	[/__NEXT_DATA__/i, "next data"],
	[/application\/ld\+json/i, "json-ld"],
];

for (const [re, label] of patterns) {
	const m = html.match(re);
	if (m) console.log(label, m.slice(0, 3));
}

const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
if (next) {
	const imgs = [...next.matchAll(/ticketm\.net[^"\\]+/gi)].map((x) => x[0].replace(/\\u002F/g, "/"));
	console.log("next ticketm imgs:", [...new Set(imgs)].slice(0, 5));
}

const ld = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
for (const block of ld.slice(0, 2)) {
	try {
		const parsed = JSON.parse(block[1]);
		console.log("json-ld image:", JSON.stringify(parsed).match(/ticketm[^"']+/gi)?.slice(0, 3));
	} catch {}
}