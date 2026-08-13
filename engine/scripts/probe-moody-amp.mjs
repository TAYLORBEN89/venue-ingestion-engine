const base = "https://moodyamphitheater.com";
const html = await (await fetch(`${base}/events-tickets`, {
	headers: { "User-Agent": "Mozilla/5.0" },
})).text();

// Pair slug links with nearby dates in HTML
const slugRe = /href=["']\/events\/([^"'#]+)["'][\s\S]{0,800}?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/gi;
let m;
const pairs = [];
while ((m = slugRe.exec(html)) !== null && pairs.length < 8) {
	pairs.push({ slug: m[1], date: `${m[2]} ${m[3]}, ${m[4]}` });
}
console.log("paired from listing", pairs);

// Also try reverse: date before link
const altRe = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})[\s\S]{0,400}?href=["']\/events\/([^"'#]+)["']/gi;
const alt = [];
while ((m = altRe.exec(html)) !== null && alt.length < 5) {
	alt.push({ slug: m[4], date: `${m[1]} ${m[2]}, ${m[3]}` });
}
console.log("alt paired", alt);