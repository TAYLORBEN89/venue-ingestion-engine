const pageRes = await fetch("https://antonesnightclub.com/calendar/", {
	headers: { "User-Agent": "Mozilla/5.0" },
});
const html = await pageRes.text();
const nonce = html.match(/"nonce"\s*:\s*"([^"]+)"/)?.[1];
const ajaxUrl = html.match(/"ajax_url"\s*:\s*"([^"]+)"/)?.[1];

const body = new URLSearchParams({
	action: "get_events_for_calendar",
	nonce: nonce ?? "",
	start: "2026-07-01",
	end: "2026-10-01",
	params: JSON.stringify({ type: "calendar" }),
});

const json = await (await fetch(ajaxUrl, {
	method: "POST",
	headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
	body,
})).json();

const e = json.events?.[1];
console.log("event:", JSON.stringify(e, null, 2));

const mobile = json.mobile_events?.[1];
console.log("\nmobile:", JSON.stringify(mobile, null, 2)?.slice(0, 1500));

const popupNonEmpty = Object.entries(json.popupdata ?? {}).find(([, v]) => typeof v === "string" && v.trim().length > 20);
console.log("\npopup non-empty:", popupNonEmpty?.[0], popupNonEmpty?.[1]?.slice(0, 800));

const list = json.mobilelistdata;
if (typeof list === "string") console.log("\nmobilelistdata snippet:", list.slice(0, 1200));