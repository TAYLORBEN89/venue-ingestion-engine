const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const url =
	"https://texashotelvegas.com/all-events/action~agenda/cat_ids~2351/events_limit~50/request_format~html/";
const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();

const article = html.match(/<article[\s\S]{0,4000}?<\/article>/i)?.[0];
console.log("article sample:", article?.replace(/\s+/g, " ").slice(0, 1500));

const eventBlocks = [...html.matchAll(/class=["'][^"']*mec-event[^"']*["'][\s\S]{0,800}/gi)].slice(0, 3);
for (const b of eventBlocks) console.log("\nblock:", b[0].replace(/\s+/g, " ").slice(0, 400));

const titled = [...html.matchAll(/class=["']mec-event-title[^"']*["'][\s\S]{0,300}?<\/a>/gi)].slice(0, 5);
console.log("\nmec-event-title blocks:", titled.length);
for (const t of titled) console.log(t[0].replace(/\s+/g, " ").slice(0, 200));