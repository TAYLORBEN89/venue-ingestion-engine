import { renderMarkdown } from "./browser";

// hotel_vegas_scraper prior art (docs/ai-ingestion-pipeline.md): when a
// venue's own page gives too little text to be useful, fall back to a web
// search for the event rather than publishing something threadbare. Applies
// to real gaps found comparing ai_ingested output against the HeyAustin
// quality-benchmark events, e.g. a description that's just a repeat of the
// title ("SOLARIS Tour" for an event titled "JOJI").
const MIN_DESCRIPTION_WORDS = 50;

function wordCount(text: string | null): number {
	if (!text) return 0;
	return text.trim().split(/\s+/).filter(Boolean).length;
}

export function isThin(description: string | null): boolean {
	return wordCount(description) < MIN_DESCRIPTION_WORDS;
}

// DuckDuckGo's lite HTML results page, rendered through Browser Run (a real
// browser, same as calendar-page rendering) rather than a bare fetch() -
// search engines routinely block/CAPTCHA plain server-to-server requests
// from cloud IPs, which a bare fetch from a Worker would be.
function searchUrl(query: string): string {
	return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

// The rendered Markdown is DuckDuckGo's results page chrome (nav, search
// box, footer links) plus each result as a heading + snippet paragraph.
// Heuristic, not a real parser: skip short/boilerplate lines, take the
// first paragraph-length line as the snippet.
function firstSnippet(markdown: string): string | null {
	const lines = markdown
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		if (line.startsWith("#") || line.startsWith("[") || line.startsWith("!")) continue;
		if (wordCount(line) >= 15) return line;
	}
	return null;
}

/**
 * Looks up an event that came back with too little description text and
 * returns a snippet to use instead, or null if nothing usable turned up
 * (never blocks ingestion - this is a best-effort enrichment, not a
 * required step, matching the "null over guessing" rule the extraction
 * prompt itself follows).
 */
export async function enrichThinDescription(
	browser: CloudflareEnv["BROWSER"],
	eventTitle: string,
	venueName: string,
): Promise<string | null> {
	try {
		const markdown = await renderMarkdown(browser, searchUrl(`"${eventTitle}" ${venueName} Austin TX`));
		return firstSnippet(markdown);
	} catch {
		return null;
	}
}
