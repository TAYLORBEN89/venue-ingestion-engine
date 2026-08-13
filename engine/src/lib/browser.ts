// Uses the Browser Run binding's quickAction() method directly (in-process,
// no API token/REST hop) rather than the Browser Rendering REST API.

export interface RenderPageOptions {
	gotoOptions?: {
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		timeout?: number;
	};
	/** Wait for a CSS selector before capturing (SPA readiness signal). */
	waitForSelector?: {
		selector: string;
		timeout?: number;
		visible?: boolean;
	};
	/** Proceed even if waitForSelector / network idle times out. */
	bestAttempt?: boolean;
}

export async function renderMarkdown(browser: CloudflareEnv["BROWSER"], url: string): Promise<string> {
	const response = await browser.quickAction("markdown", {
		url,
		gotoOptions: { waitUntil: "networkidle2", timeout: 30000 },
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error(`Browser Run markdown failed with ${response.status}: ${detail}`);
	}

	const data = await response.json<{ success: boolean; result: string }>();
	if (!data.success || typeof data.result !== "string") {
		throw new Error("Browser Run markdown response missing result");
	}
	return data.result;
}

/** Render fully hydrated HTML — needed when CMS-bound images only appear after JS runs. */
export async function renderPageContent(
	browser: CloudflareEnv["BROWSER"],
	url: string,
	options?: RenderPageOptions,
): Promise<string> {
	const response = await browser.quickAction("content", {
		url,
		gotoOptions: options?.gotoOptions ?? { waitUntil: "networkidle2" as const, timeout: 30000 },
		...(options?.waitForSelector
			? {
					waitForSelector: {
						selector: options.waitForSelector.selector,
						timeout: options.waitForSelector.timeout,
						...(options.waitForSelector.visible ? { visible: true as const } : {}),
					},
				}
			: {}),
		...(options?.bestAttempt !== undefined ? { bestAttempt: options.bestAttempt } : {}),
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error(`Browser Run content failed with ${response.status}: ${detail}`);
	}

	const data = await response.json<{ success: boolean; result: string }>();
	if (!data.success || typeof data.result !== "string") {
		throw new Error("Browser Run content response missing result");
	}
	return data.result;
}
