import { toFetchableUrl } from "./discover";

const BROWSER_HEADERS = {
	Accept: "text/calendar,text/html,application/json,*/*",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export async function fetchPageText(url: string): Promise<string> {
	const res = await fetch(toFetchableUrl(url), { headers: BROWSER_HEADERS });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} fetching ${url}`);
	}
	return res.text();
}