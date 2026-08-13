const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const urls = [
	"https://moodycenteratx.com/event/dude-perfect/",
	"https://moodycenteratx.com/event/joji-solaris/",
	"https://moodyamphitheater.com/events/young-the-giant",
];

for (const url of urls) {
	const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
	console.log("\n", url);
	const og =
		html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
	console.log("og:image:", og);
	const imgs = [...new Set([...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]))].filter((u) =>
		/event|ticketm|artist|hero|poster/i.test(u),
	);
	console.log("img tags:", imgs.slice(0, 6));
}