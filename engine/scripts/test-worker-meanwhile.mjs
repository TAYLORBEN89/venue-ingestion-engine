const res = await fetch("https://events-platform-ingestion.ben-745.workers.dev/test-source", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: "https://www.meanwhilebeer.com/events",
		venueName: "Meanwhile Brewing Company",
		scrapeDaysAhead: 90,
	}),
});
const data = await res.json();
console.log("ready:", data.ready, "events:", data.events_found, "has_images:", data.has_images);
console.log("messages:", data.messages);
for (const t of data.sample_titles ?? []) console.log(" -", t);

// fetch debug render for ring page
const dbg = await fetch(
	"https://events-platform-ingestion.ben-745.workers.dev/debug-render?url=" +
		encodeURIComponent(
			"https://www.meanwhilebeer.com/events/ticketed-class-make-your-own-silver-ring-with-raw-metals-2",
		),
);
const text = await dbg.text();
const hasImage8 = /image-8|Ring%20Making/i.test(text);
console.log("debug-render has image-8:", hasImage8, "len:", text.length);