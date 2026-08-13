const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const listHtml = await (await fetch("https://www.meanwhilebeer.com/events", { headers: { "User-Agent": UA } })).text();

// Grab chunks around each /events/slug link
const slugs = [...new Set([...listHtml.matchAll(/href=["']\/events\/([^"'#?]+)["']/gi)].map((m) => m[1]))];
for (const slug of slugs.slice(0, 5)) {
	const idx = listHtml.indexOf(`/events/${slug}`);
	const chunk = listHtml.slice(Math.max(0, idx - 200), idx + 800);
	const text = chunk
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, "\n")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 2);
	console.log("\n---", slug, "---");
	console.log(text.slice(0, 12).join(" | "));
}

const detail = await (await fetch("https://www.meanwhilebeer.com/events/tuesday-trivia-73", { headers: { "User-Agent": UA } })).text();
const detailText = detail
	.replace(/<script[\s\S]*?<\/script>/gi, "")
	.replace(/<style[\s\S]*?<\/style>/gi, "");
const blocks = [...detailText.matchAll(/class=["']([^"']+)["'][^>]*>([\s\S]*?)<\/div>/gi)]
	.map((m) => ({ cls: m[1], text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }))
	.filter((b) => b.text.length > 3 && b.text.length < 120)
	.slice(0, 40);
console.log("\nDetail div texts:");
for (const b of blocks) {
	if (/trivia|july|pm|am|event|tuesday/i.test(b.text)) console.log(b.cls, "=>", b.text);
}