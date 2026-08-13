const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const html = await (
	await fetch("https://moodyamphitheater.com/events/young-the-giant", { headers: { "User-Agent": UA } })
).text();

const needles = ["ticketm", "youtube", "youtu", "iframe", "video", "dam/a/", "embed", "w-dyn-bind", "w-json"];
for (const n of needles) {
	const c = (html.match(new RegExp(n, "gi")) || []).length;
	if (c) console.log(n, c);
}

// Webflow often puts collection data in comments or scripts
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
console.log("script blocks", scripts.length);
for (const s of scripts) {
	if (/ticketm|youtube|video|embed/i.test(s)) {
		console.log("interesting script:", s.slice(0, 500).replace(/\s+/g, " "));
	}
}

// Search raw for ticketm even encoded
const encoded = [...html.matchAll(/ticketm/gi)];
console.log("ticketm mentions", encoded.length);

// Look for w-dyn-bind-empty fields that might be CMS placeholders
const emptyBinds = [...html.matchAll(/w-dyn-bind-empty/gi)].length;
console.log("w-dyn-bind-empty count", emptyBinds);

// Full body text search for video section
const bodyIdx = html.indexOf("w-dyn-bind-empty");
if (bodyIdx >= 0) {
	console.log("sample bind area:", html.slice(bodyIdx - 200, bodyIdx + 800).replace(/\s+/g, " "));
}

// Check if there's a second fetch URL - webflow item API
console.log("\nWebflow site id:", html.match(/data-wf-site="([^"]+)"/)?.[1]);
console.log("collection:", html.match(/data-wf-collection="([^"]+)"/)?.[1]);
console.log("item slug:", html.match(/data-wf-item-slug="([^"]+)"/)?.[1]);