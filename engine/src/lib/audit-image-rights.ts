/**
 * Vision check for photographer watermarks / stock marks / credits.
 * Used by POST /audit-image-rights (authenticated).
 */

export type ImageRightsAudit = {
	watermark: boolean;
	photographer_credit: boolean;
	stock_agency: boolean;
	visible_credit_text: string;
	confidence: number;
	notes: string;
	model: string;
	raw?: string;
};

const PROMPT = `You are checking a photograph for copyright-risk overlays on a public website.

Inspect corners, edges, bottom strip, and semi-transparent text carefully.

Return ONLY compact JSON (no markdown fences, no escaped underscores in keys):
{"watermark":false,"photographer_credit":false,"stock_agency":false,"visible_credit_text":"","confidence":0.0,"notes":""}

Rules:
- watermark: true if any ownership overlay (©, translucent name, logo stamp, agency mark)
- photographer_credit: true if photographer/studio name or "photo by" is burned in
- stock_agency: true for Getty, Shutterstock, Adobe Stock, Alamy, iStock, WireImage, etc.
- visible_credit_text: copy the credit/watermark text if readable, else ""
- confidence: 0 to 1
- Ignore band merch logos and venue signs that are part of the scene
- If unsure but you see a © name or photographer website in a corner, set watermark and photographer_credit true`;

function clamp01(n: unknown): number {
	const x = typeof n === "number" ? n : Number(n);
	if (!Number.isFinite(x)) return 0;
	return Math.max(0, Math.min(1, x));
}

/** Normalize model JSON quirks (escaped underscores, single quotes, trailing commas). */
function parseModelJson(text: string): Partial<ImageRightsAudit> | null {
	let raw = text.trim();
	// strip markdown fences
	raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let slice = raw.slice(start, end + 1);
	// Models often emit photographer\_credit (invalid JSON escapes)
	slice = slice.replace(/\\_/g, "_");
	// Also fix keys written with literal backslash-underscore sequences
	slice = slice.replace(/([A-Za-z])\\+_([A-Za-z])/g, "$1_$2");
	try {
		return JSON.parse(slice) as Partial<ImageRightsAudit>;
	} catch {
		try {
			const softer = slice.replace(/,\s*}/g, "}").replace(/'/g, '"');
			return JSON.parse(softer) as Partial<ImageRightsAudit>;
		} catch {
			// Last resort: pull booleans with regex
			const flag = (name: string) => {
				const re = new RegExp(`"${name}"\\s*:\\s*(true|false)`, "i");
				const m = slice.match(re);
				return m ? m[1].toLowerCase() === "true" : undefined;
			};
			const conf = slice.match(/"confidence"\s*:\s*([0-9.]+)/i);
			const textM = slice.match(/"visible_credit_text"\s*:\s*"([^"]*)"/i);
			const notesM = slice.match(/"notes"\s*:\s*"([^"]*)"/i);
			const watermark = flag("watermark");
			if (watermark === undefined && flag("photographer_credit") === undefined) return null;
			return {
				watermark: Boolean(watermark),
				photographer_credit: Boolean(flag("photographer_credit")),
				stock_agency: Boolean(flag("stock_agency")),
				visible_credit_text: textM?.[1] || "",
				confidence: conf ? Number(conf[1]) : 0.5,
				notes: notesM?.[1] || "regex_parsed",
			};
		}
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
	}
	return btoa(binary);
}

function extractResponseText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return String(result ?? "");
	const r = result as Record<string, unknown>;
	if (typeof r.response === "string") return r.response;
	if (typeof r.description === "string") return r.description;
	if (typeof r.result === "string") return r.result;
	// OpenAI-style
	const choices = r.choices as Array<{ message?: { content?: string } }> | undefined;
	if (choices?.[0]?.message?.content) return choices[0].message.content;
	return JSON.stringify(result);
}

function toAudit(parsed: Partial<ImageRightsAudit> | null, raw: string, model: string): ImageRightsAudit {
	if (!parsed) {
		const lower = raw.toLowerCase();
		// Only treat as positive if model explicitly sets true, not mere mention of "watermark"
		const watermarkTrue = /"watermark"\s*:\s*true/i.test(raw);
		const creditTrue = /"photographer_credit"\s*:\s*true/i.test(raw);
		const stockTrue = /"stock_agency"\s*:\s*true/i.test(raw);
		const narrativePositive =
			!/no watermark|not contain|doesn't contain|does not contain|no visible/.test(lower) &&
			/\b(©|copyright\s+[A-Z]|photo\s*by\s+[A-Z]|getty images|shutterstock)\b/i.test(raw);
		return {
			watermark: watermarkTrue || narrativePositive,
			photographer_credit: creditTrue || narrativePositive,
			stock_agency: stockTrue,
			visible_credit_text: "",
			confidence: watermarkTrue || creditTrue || stockTrue ? 0.55 : 0.3,
			notes: "unparsed_model_output",
			model,
			raw: raw.slice(0, 1000),
		};
	}

	return {
		watermark: Boolean(parsed.watermark),
		photographer_credit: Boolean(parsed.photographer_credit),
		stock_agency: Boolean(parsed.stock_agency),
		visible_credit_text: String(parsed.visible_credit_text || "").slice(0, 300),
		confidence: clamp01(parsed.confidence),
		notes: String(parsed.notes || "").slice(0, 400),
		model,
		raw: raw.slice(0, 1000),
	};
}

function mergeAudits(a: ImageRightsAudit, b: ImageRightsAudit): ImageRightsAudit {
	const watermark = a.watermark || b.watermark;
	const photographer_credit = a.photographer_credit || b.photographer_credit;
	const stock_agency = a.stock_agency || b.stock_agency;
	const visible_credit_text = [a.visible_credit_text, b.visible_credit_text]
		.filter(Boolean)
		.join(" | ")
		.slice(0, 300);
	const confidence = Math.max(a.confidence, b.confidence);
	return {
		watermark,
		photographer_credit,
		stock_agency,
		visible_credit_text,
		confidence,
		notes: [a.notes, b.notes].filter(Boolean).join(" · ").slice(0, 400),
		model: `${a.model}+${b.model}`,
		raw: [a.raw, b.raw].filter(Boolean).join("\n---\n").slice(0, 1500),
	};
}

async function runLlamaVision(ai: Ai, imageBytes: Uint8Array, prompt: string): Promise<ImageRightsAudit> {
	const model = "@cf/meta/llama-3.2-11b-vision-instruct";
	const b64 = bytesToBase64(imageBytes);
	const dataUrl = `data:image/jpeg;base64,${b64}`;

	// Preferred: multimodal chat messages
	try {
		const result = await ai.run(model as Parameters<Ai["run"]>[0], {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: dataUrl } },
					],
				},
			],
			max_tokens: 350,
			temperature: 0,
		} as Record<string, unknown>);
		const raw = extractResponseText(result);
		return toAudit(parseModelJson(raw), raw, model);
	} catch {
		/* try alternate payloads */
	}

	try {
		const result = await ai.run(model as Parameters<Ai["run"]>[0], {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image", image: Array.from(imageBytes) },
					],
				},
			],
			max_tokens: 350,
		} as Record<string, unknown>);
		const raw = extractResponseText(result);
		return toAudit(parseModelJson(raw), raw, model);
	} catch {
		/* last shape */
	}

	const result = await ai.run(model as Parameters<Ai["run"]>[0], {
		prompt,
		image: Array.from(imageBytes),
		max_tokens: 350,
	} as Record<string, unknown>);
	const raw = extractResponseText(result);
	return toAudit(parseModelJson(raw), raw, model);
}

async function runLlava(ai: Ai, imageBytes: Uint8Array, prompt: string): Promise<ImageRightsAudit> {
	const model = "@cf/llava-hf/llava-1.5-7b-hf";
	const result = await ai.run(model as Parameters<Ai["run"]>[0], {
		prompt,
		image: Array.from(imageBytes),
		max_tokens: 350,
	} as Record<string, unknown>);
	const raw = extractResponseText(result);
	return toAudit(parseModelJson(raw), raw, model);
}

/**
 * Full image + optional second pass is done by caller sending corner crop.
 * Here we try Llama vision first, fall back to LLaVA.
 */
async function runMistralVision(ai: Ai, imageBytes: Uint8Array, prompt: string): Promise<ImageRightsAudit> {
	const model = "@cf/mistralai/mistral-small-3.1-24b-instruct";
	const b64 = bytesToBase64(imageBytes);
	const dataUrl = `data:image/jpeg;base64,${b64}`;
	const result = await ai.run(model as Parameters<Ai["run"]>[0], {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: prompt },
					{ type: "image_url", image_url: { url: dataUrl } },
				],
			},
		],
		max_tokens: 350,
		temperature: 0,
	} as Record<string, unknown>);
	const raw = extractResponseText(result);
	return toAudit(parseModelJson(raw), raw, model);
}

/**
 * Prefer stronger multimodal models; fall back down the ladder.
 * Any positive finding short-circuits to that result (OR across models if all run).
 */
export async function auditImageRightsWithAi(
	ai: Ai,
	imageBytes: Uint8Array,
): Promise<ImageRightsAudit> {
	// Single strong model first (cost/latency). Optional LLaVA fallback only on hard fail.
	try {
		return await runMistralVision(ai, imageBytes, PROMPT);
	} catch (e1) {
		try {
			return await runLlava(ai, imageBytes, PROMPT);
		} catch (e2) {
			const msg1 = e1 instanceof Error ? e1.message : String(e1);
			const msg2 = e2 instanceof Error ? e2.message : String(e2);
			return {
				watermark: false,
				photographer_credit: false,
				stock_agency: false,
				visible_credit_text: "",
				confidence: 0,
				notes: `vision_failed: ${msg1} | ${msg2}`,
				model: "none",
				raw: "",
			};
		}
	}
}

export { mergeAudits, PROMPT };
