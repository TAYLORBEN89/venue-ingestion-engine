const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const urls = [
	"https://moodyamphitheater.com/events/young-the-giant",
	"https://moodycenteratx.com/event/dude-perfect/",
];

for (const url of urls) {
	const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
	const html = await res.text();
	console.log(`\n=== ${res.status} ${url} ===`);
	const ticketm = [...new Set([...html.matchAll(/https:\/\/s\d\.ticketm\.net\/[^"'\s]+/gi)].map((m) => m[0]))];
	console.log("ticketm.net on page:", ticketm.slice(0, 5));
	const tmLink = html.match(/href=["'](https:\/\/www\.ticketmaster\.com[^"']+)["']/i)?.[1];
	console.log("ticketmaster link:", tmLink);
	const og =
		html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
	console.log("og:image:", og);
	const wf = [...new Set([...html.matchAll(/https:\/\/cdn\.prod\.website-files\.com[^"'\s]+/gi)].map((m) => m[0]))];
	console.log("webflow images:", wf.slice(0, 3));

	if (tmLink) {
		const tm = await fetch(tmLink, { headers: { "User-Agent": UA }, redirect: "follow" });
		const tmHtml = await tm.text();
		const tmImgs = [...new Set([...tmHtml.matchAll(/https:\/\/s\d\.ticketm\.net\/[^"'\s]+/gi)].map((m) => m[0]))];
		console.log("ticketm on TM page:", tmImgs.slice(0, 5));
		const tmOg =
			tmHtml.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
			tmHtml.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
		console.log("TM og:image:", tmOg);
	}
}