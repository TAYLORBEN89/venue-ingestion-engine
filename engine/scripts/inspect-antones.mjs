const url = "https://antonesnightclub.com/calendar/";
const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
const html = await res.text();

const ajax = [...html.matchAll(/ajaxurl|admin-ajax|wp-json|loadEvents|action['":\s]+['"]([^'"]+)['"]/gi)];
console.log("ajax mentions:", [...new Set(ajax.map((m) => m[0] || m[1]))].slice(0, 20));

const urls = [...html.matchAll(/https?:\/\/[^"'\s]+/gi)]
	.map((m) => m[0])
	.filter((u) => /ajax|calendar|event|tw-|plugin/i.test(u));
console.log("\ninteresting urls:", [...new Set(urls)].slice(0, 30));

const loadEventsIdx = html.indexOf("function loadEvents");
if (loadEventsIdx >= 0) {
	console.log("\nloadEvents fn:");
	console.log(html.slice(loadEventsIdx, loadEventsIdx + 3500).replace(/\s+/g, " "));
}

const actions = [...html.matchAll(/action:\s*['"]([^'"]+)['"]/gi)];
console.log("\naction values:", [...new Set(actions.map((m) => m[1]))]);