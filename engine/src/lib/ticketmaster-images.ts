const TM_IMAGE_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "application/json",
};

export function extractTicketmasterEventId(url: string | null | undefined): string | null {
	if (!url) return null;
	const match = url.match(/ticketmaster\.com\/event\/([A-Za-z0-9]+)/i);
	return match?.[1] ?? null;
}

interface TicketmasterImage {
	url: string;
	width: number;
	height: number;
	ratio?: string;
}

function pickBestTicketmasterImage(images: TicketmasterImage[]): string | null {
	if (images.length === 0) return null;

	const scored = images.map((img) => {
		let score = img.width * img.height;
		const ratio = img.ratio ?? "";
		if (ratio === "16_9") score += 50_000;
		if (img.url.includes("EVENT_DETAIL_PAGE")) score += 25_000;
		return { url: img.url, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored[0]?.url ?? null;
}

/** Discovery API image lookup — requires a Ticketmaster developer API key. */
export async function fetchTicketmasterEventImage(
	eventId: string,
	apiKey: string,
): Promise<string | null> {
	const endpoint = `https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(eventId)}.json?apikey=${encodeURIComponent(apiKey)}`;
	const res = await fetch(endpoint, { headers: TM_IMAGE_HEADERS });
	if (!res.ok) return null;

	const data = (await res.json()) as {
		images?: TicketmasterImage[];
	};
	return pickBestTicketmasterImage(data.images ?? []);
}

export async function resolveTicketmasterImageFromUrl(
	ticketUrl: string | null | undefined,
	apiKey: string | null | undefined,
): Promise<string | null> {
	if (!apiKey) return null;
	const eventId = extractTicketmasterEventId(ticketUrl);
	if (!eventId) return null;
	return fetchTicketmasterEventImage(eventId, apiKey);
}