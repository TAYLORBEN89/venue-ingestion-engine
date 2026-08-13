const url = "https://the-velveeta-room-the-velveeta-room.seatengine.com/calendar";
const html = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
const chunks = html.split("/shows/");
console.log("show chunks", chunks.length - 1);
for (const chunk of chunks.slice(1, 4)) {
	const id = chunk.match(/^(\d+)/)?.[1];
	const title = chunk.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</i)?.[1] ?? chunk.match(/>([^<]{5,60})</)?.[1];
	const date = chunk.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1];
	console.log({ id, title: title?.trim(), date });
}