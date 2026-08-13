import { renderMarkdown } from "./browser";

function searchUrl(query: string): string {
	return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Pull paragraph-length lines from DuckDuckGo result markdown. */
export function extractSearchSnippets(markdown: string, limit = 6): string[] {
	const snippets: string[] = [];
	const seen = new Set<string>();

	for (const line of markdown.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#") || trimmed.startsWith("[") || trimmed.startsWith("!")) continue;
		if (wordCount(trimmed) < 12) continue;
		if (/duckduckgo|privacy|settings|feedback/i.test(trimmed)) continue;

		const key = trimmed.slice(0, 80).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		snippets.push(trimmed);
		if (snippets.length >= limit) break;
	}

	return snippets;
}

export interface ArtistResearchBundle {
	bioSnippets: string[];
	youtubeSnippets: string[];
}

export async function researchArtist(
	browser: CloudflareEnv["BROWSER"],
	bandName: string,
	city?: string | null,
): Promise<ArtistResearchBundle> {
	const location = city ?? "Austin";
	const queries = [
		`"${bandName}" musician band biography genre`,
		`"${bandName}" official music video youtube`,
		`"${bandName}" ${location} live music`,
	];

	const bioSnippets: string[] = [];
	const youtubeSnippets: string[] = [];

	for (const [index, query] of queries.entries()) {
		try {
			const markdown = await renderMarkdown(browser, searchUrl(query));
			const snippets = extractSearchSnippets(markdown, 5);
			if (index === 1) {
				youtubeSnippets.push(...snippets);
			} else {
				bioSnippets.push(...snippets);
			}
		} catch {
			// Best-effort — generation still runs with thinner context.
		}
	}

	return {
		bioSnippets: [...new Set(bioSnippets)].slice(0, 8),
		youtubeSnippets: [...new Set(youtubeSnippets)].slice(0, 4),
	};
}