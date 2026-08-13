const res = await fetch("https://stubbsaustin.com/concert-calendar/", {
	headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
});
const html = await res.text();
const nonce = html.match(/"nonce"\s*:\s*"([^"]+)"/)?.[1];
const ajaxUrl = html.match(/"ajax_url"\s*:\s*"([^"]+)"/)?.[1];
console.log({ nonce, ajaxUrl });

const body = new URLSearchParams({
	action: "get_events_for_calendar",
	nonce: nonce ?? "",
	start: "2026-07-01",
	end: "2026-10-01",
	params: JSON.stringify({ type: "calendar" }),
});
const api = await fetch(ajaxUrl, {
	method: "POST",
	headers: {
		"Content-Type": "application/x-www-form-urlencoded",
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		Referer: "https://stubbsaustin.com/concert-calendar/",
	},
	body,
});
const text = await api.text();
console.log("api status", api.status, "ct", api.headers.get("content-type"));
console.log(text.slice(0, 200));
try {
	const json = JSON.parse(text);
	console.log("events", json.events?.length ?? json);
	if (json.events?.[0]) console.log("sample", json.events[0].title, json.events[0].sortkey);
} catch {
	console.log("not json");
}