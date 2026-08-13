const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const urls = [
	"https://moodyamphitheater.com/events-tickets",
	"https://moodyamphitheater.com/events/young-the-giant",
];

for (const url of urls) {
	const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
	const html = await res.text();
	console.log(`\n======== ${url} ========`);
	console.log("status", res.status, "len", html.length);

	const ticketm = [...new Set([...html.matchAll(/https?:\/\/s\d\.ticketm\.net\/[^"'\s<>]+/gi)].map((m) => m[0]))];
	console.log("ticketm.net URLs:", ticketm.length);
	for (const u of ticketm.slice(0, 8)) console.log(" ", u);

	const yt = [
		...new Set(
			[
				...[...html.matchAll(/youtube\.com\/embed\/([^"'\s?&]+)/gi)].map((m) => m[1]),
				...[...html.matchAll(/youtu\.be\/([^"'\s?&]+)/gi)].map((m) => m[1]),
				...[...html.matchAll(/youtube\.com\/watch\?v=([^"'\s&]+)/gi)].map((m) => m[1]),
			],
		),
	];
	console.log("youtube ids:", yt);

	const og =
		html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
	console.log("og:image:", og);

	// young-the-giant link block context
	const idx = html.indexOf("young-the-giant");
	if (idx >= 0) {
		const chunk = html.slice(Math.max(0, idx - 300), idx + 2500);
		console.log("\n--- chunk around young-the-giant ---");
		console.log(chunk.replace(/\s+/g, " ").slice(0, 2000));
	}

	// all img src
	const imgs = [...new Set([...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]))].filter((u) =>
		/ticketm|youtube|website-files|dam\//i.test(u),
	);
	console.log("\nrelevant img src:", imgs.slice(0, 10));

	// data attributes
	const dataImgs = [...html.matchAll(/data-[^=]*=["']([^"']*ticketm[^"']*)["']/gi)].map((m) => m[1]).slice(0, 5);
	console.log("data-* ticketm:", dataImgs);
}