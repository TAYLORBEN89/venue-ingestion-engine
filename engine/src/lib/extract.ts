import type { ExtractedEvent } from "../types";

// Workers AI: free allocation (10,000 Neurons/day) on every Cloudflare
// account, called via the in-Worker AI binding — no separate API key/credits
// needed, unlike the third-party providers this was originally built against.
const CHEAP_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const STRONG_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const LOW_CONFIDENCE_THRESHOLD = 0.6;

// Busy venues (Stubb's, 64+ upcoming shows) render enough Markdown that a
// single extraction call times out (AiError 3046) rather than truncating
// and silently losing the events after wherever the cutoff happens to
// land — the whole page still gets covered, just as several calls instead
// of one.
const MAX_CHUNK_CHARS = 8000;

const EVENT_SCHEMA = {
	type: "object",
	properties: {
		events: {
			type: "array",
			items: {
				type: "object",
				properties: {
					raw_title: {
						type: "string",
						description:
							"The event/artist's plain name. Strip decorative wrapping punctuation the page's own styling adds around it (e.g. the page shows '[ JOJI ]' -> extract 'JOJI'), but keep the actual title text itself exactly as written.",
					},
					raw_date_text: {
						type: "string",
						description:
							"The date/time exactly as written on the page (before any parsing), e.g. 'Fri, Aug 14 · 8:00 PM'.",
					},
					parsed_starts_at: {
						type: ["string", "null"],
						description:
							"Start date+time resolved to full ISO 8601 UTC (e.g. '2026-08-15T01:00:00Z'), using the supplied venue timezone and current date to resolve any relative or year-less dates. Null if it cannot be confidently resolved.",
					},
					parsed_ends_at: {
						type: ["string", "null"],
						description: "End date+time in ISO 8601 UTC if the page states one, otherwise null. Do not guess a duration.",
					},
					description: {
						type: ["string", "null"],
						description: "Event description/summary text, if present.",
					},
					price_text: {
						type: ["string", "null"],
						description: "Price/cost exactly as written (e.g. '$15 adv / $20 door', 'Free'), if present.",
					},
					ticket_url: {
						type: ["string", "null"],
						description:
							"URL from ticket/RSVP buttons (Tickets, Buy Tickets, RSVP, More Info, Eventbrite, See Tickets, AXS, Dice, Prekindle, Universe, etc.) or vendor domains (eventbrite.com, axs.com, dice.fm, ticketmaster.com, seatengine.com). Must be a real absolute URL — not '#' or javascript: placeholders.",
					},
					image_url: {
						type: ["string", "null"],
						description:
							"URL of this event's flyer/photo image, if the page has one — markdown image syntax ![alt](url) near the event's title/listing. Use the specific event's own image, not a venue logo or unrelated header image. Null if none is clearly associated with this event.",
					},
					confidence: {
						type: "number",
						description: "Your confidence (0-1) that this event and its start date were extracted correctly.",
					},
				},
				required: [
					"raw_title",
					"raw_date_text",
					"parsed_starts_at",
					"parsed_ends_at",
					"description",
					"price_text",
					"ticket_url",
					"image_url",
					"confidence",
				],
			},
		},
	},
	required: ["events"],
};

// Splits on paragraph boundaries (calendar pages render each event as its
// own contiguous block separated by a blank line) so a single event's
// title/date/description isn't split across two chunks.
function chunkContent(content: string, maxChars: number): string[] {
	if (content.length <= maxChars) return [content];

	const paragraphs = content.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	for (const paragraph of paragraphs) {
		if (current.length > 0 && current.length + paragraph.length + 2 > maxChars) {
			chunks.push(current);
			current = paragraph;
		} else {
			current = current ? `${current}\n\n${paragraph}` : paragraph;
		}
	}
	if (current) chunks.push(current);

	return chunks;
}

function buildPrompt(venueName: string, timezone: string, sourceUrl: string, content: string): string {
	const today = new Date().toISOString().slice(0, 10);
	return `You are extracting events from "${venueName}"'s events/calendar page (${sourceUrl}), rendered to Markdown below.

Today's date is ${today}. The venue's local timezone is ${timezone} — use it to resolve any date/time that is relative ("this Friday"), missing a year, or missing a timezone into a correct absolute UTC timestamp.

List every distinct event on the page, not just the first few. Do not invent events, ticket URLs, prices, or images that aren't present in the content. If a field isn't present, use null rather than guessing.

--- PAGE CONTENT (Markdown) ---
${content}
--- END PAGE CONTENT ---`;
}

// Placeholder hrefs calendar widgets use for JS-modal buttons rather than a
// real link ("#", "javascript:void(0)", etc.) - a code-level backstop for
// when the model copies one literally despite the schema's instruction not
// to, per the "Buy Tickets" / "#" pattern found comparing ai_ingested output
// against the HeyAustin quality-benchmark events.
function sanitizeUrl(url: string | null): string | null {
	if (!url) return null;
	const trimmed = url.trim();
	if (trimmed === "" || trimmed === "#" || /^javascript:/i.test(trimmed)) return null;
	return trimmed;
}

// Strips decorative wrapping punctuation some venues' listing pages style
// titles with (e.g. Moody Center's "[ JOJI ]") - a backstop for the same
// reason as sanitizeUrl above: the schema asks the model to do this, but
// don't rely on prompt compliance alone for something this mechanical.
function sanitizeTitle(title: string): string {
	// Decode HTML entities (some pages / models echo &amp; &#039;)
	let t = title.trim();
	for (let i = 0; i < 3; i++) {
		const next = t
			.replace(/&amp;/gi, "&")
			.replace(/&#0*39;|&apos;/gi, "'")
			.replace(/&#8217;/g, "'")
			.replace(/&quot;/gi, '"')
			.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
		if (next === t) break;
		t = next;
	}
	return t.replace(/^[[({]\s*/, "").replace(/\s*[\])}]$/, "").trim();
}

function sanitizeEvent(event: ExtractedEvent): ExtractedEvent {
	return {
		...event,
		raw_title: sanitizeTitle(event.raw_title),
		ticket_url: sanitizeUrl(event.ticket_url),
	};
}

async function callModel(ai: CloudflareEnv["AI"], model: string, prompt: string): Promise<ExtractedEvent[]> {
	const result = await ai.run(model, {
		messages: [{ role: "user", content: prompt }],
		response_format: { type: "json_schema", json_schema: EVENT_SCHEMA },
		// A calendar page can list dozens of events; the default output-token
		// budget is too small for that and truncates the JSON mid-string.
		max_tokens: 4096,
	});

	// Workers AI JSON mode returns the parsed object under `response` for
	// most models, but treat a bare object as valid too rather than assume.
	const raw = typeof result === "object" && result !== null && "response" in result ? (result as { response: unknown }).response : result;

	try {
		const parsedResult = typeof raw === "string" ? JSON.parse(raw) : raw;
		const events = (parsedResult as { events?: ExtractedEvent[] } | null)?.events;
		return (events ?? []).map(sanitizeEvent);
	} catch {
		// Treat malformed JSON as "nothing usable came back" rather than
		// failing the whole ingestion run — the caller escalates to a
		// stronger model when a pass comes back empty.
		return [];
	}
}

async function extractChunk(
	ai: CloudflareEnv["AI"],
	venueName: string,
	timezone: string,
	sourceUrl: string,
	content: string,
): Promise<ExtractedEvent[]> {
	const prompt = buildPrompt(venueName, timezone, sourceUrl, content);

	const cheapResult = await callModel(ai, CHEAP_MODEL, prompt);
	const needsEscalation =
		cheapResult.length === 0 || cheapResult.some((event) => event.confidence < LOW_CONFIDENCE_THRESHOLD);

	if (!needsEscalation) {
		return cheapResult;
	}

	return callModel(ai, STRONG_MODEL, prompt);
}

/**
 * Extracts structured events from a venue calendar page's rendered content.
 * Splits large pages into chunks (see MAX_CHUNK_CHARS) and extracts each
 * sequentially, since a single call over a busy venue's full page can time
 * out. Each chunk starts with a cheap/fast model, escalating to a larger
 * one if that pass comes back empty or with low-confidence results, per
 * the ingestion pipeline's cost-control design (docs/ai-ingestion-pipeline.md).
 */
export async function extractEvents(params: {
	ai: CloudflareEnv["AI"];
	venueName: string;
	timezone: string;
	sourceUrl: string;
	content: string;
}): Promise<ExtractedEvent[]> {
	const chunks = chunkContent(params.content, MAX_CHUNK_CHARS);

	const events: ExtractedEvent[] = [];
	for (const chunk of chunks) {
		const chunkEvents = await extractChunk(params.ai, params.venueName, params.timezone, params.sourceUrl, chunk);
		events.push(...chunkEvents);
	}
	return events;
}
