/**
 * Shared-secret auth for the public HTTP surface of the ingestion Worker.
 *
 * Set the same value as admin's INGESTION_API_SECRET:
 *   wrangler secret put INGESTION_API_SECRET
 *
 * Cron / Workflows do not go through this (they are not HTTP).
 */

function timingSafeEqualString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) {
		out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return out === 0;
}

function providedSecret(request: Request): string | null {
	const auth = request.headers.get("authorization");
	if (auth && /^Bearer\s+/i.test(auth)) {
		const t = auth.replace(/^Bearer\s+/i, "").trim();
		if (t) return t;
	}
	const header = request.headers.get("x-ingestion-secret")?.trim();
	if (header) return header;
	const url = new URL(request.url);
	const q = url.searchParams.get("secret")?.trim();
	if (q) return q;
	return null;
}

/**
 * @returns null if authorized; otherwise a Response to return immediately.
 */
export function requireIngestionAuth(
	request: Request,
	env: { INGESTION_API_SECRET?: string },
): Response | null {
	const expected = env.INGESTION_API_SECRET?.trim() ?? "";
	if (!expected) {
		return Response.json(
			{
				error:
					"Ingestion HTTP is locked until INGESTION_API_SECRET is set on this Worker (and the same value on admin as INGESTION_API_SECRET).",
			},
			{ status: 503 },
		);
	}

	const got = providedSecret(request);
	if (!got || !timingSafeEqualString(got, expected)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	return null;
}
