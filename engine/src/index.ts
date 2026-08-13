export { IngestionSchedulerWorkflow } from "./workflows/scheduler";
export { VenueIngestionWorkflow } from "./workflows/venue-ingestion";

// HTTP surface for admin portal (test source, manual scrape, artist gen).
// All routes require INGESTION_API_SECRET (Bearer or X-Ingestion-Secret).
// Cron/Workflows are not HTTP and do not use this gate.
import { auditImageRightsWithAi } from "./lib/audit-image-rights";
import { renderMarkdown, renderPageContent } from "./lib/browser";
import { collapsePendingIngestedDuplicates } from "./lib/dedup";
import { createArtistFromResearch } from "./lib/ensure-artist-catalog";
import { requireIngestionAuth } from "./lib/http-auth";
import { createServiceRoleClient } from "./lib/supabase";
import { testVenueSource } from "./lib/sources/test-source";

export default {
	async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
		const url = new URL(request.url);

		// Health — no secrets, no side effects
		if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
			return Response.json({
				ok: true,
				service: "events-platform-ingestion",
				authRequired: true,
			});
		}

		const denied = requireIngestionAuth(request, env);
		if (denied) return denied;

		// Copyright triage: vision check for watermarks / photographer credits
		// POST { imageUrl: string } or raw image body with content-type image/*
		if (request.method === "POST" && url.pathname === "/audit-image-rights") {
			try {
				const ct = request.headers.get("content-type") || "";
				let bytes: Uint8Array;
				if (ct.includes("application/json")) {
					const body = (await request.json()) as { imageUrl?: string; imageBase64?: string };
					if (body.imageBase64) {
						const bin = atob(body.imageBase64.replace(/^data:image\/\w+;base64,/, ""));
						bytes = new Uint8Array(bin.length);
						for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
					} else if (body.imageUrl) {
						const imgRes = await fetch(body.imageUrl, {
							headers: { "User-Agent": "events-platform-watermark-audit/1.0" },
						});
						if (!imgRes.ok) {
							return Response.json(
								{ error: `Failed to fetch image: HTTP ${imgRes.status}` },
								{ status: 400 },
							);
						}
						bytes = new Uint8Array(await imgRes.arrayBuffer());
					} else {
						return Response.json(
							{ error: "Expected { imageUrl } or { imageBase64 }" },
							{ status: 400 },
						);
					}
				} else if (ct.startsWith("image/")) {
					bytes = new Uint8Array(await request.arrayBuffer());
				} else {
					return Response.json(
						{ error: "Send JSON { imageUrl } or image/* body" },
						{ status: 400 },
					);
				}

				// Cap payload size (~4.5MB)
				if (bytes.byteLength > 4_500_000) {
					return Response.json({ error: "Image too large (max ~4.5MB)" }, { status: 413 });
				}

				const audit = await auditImageRightsWithAi(env.AI, bytes);
				return Response.json({ ok: true, ...audit });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		// Debug TEC fetch path from the Worker network (WAF / UA / browser).
		if (request.method === "GET" && url.pathname === "/debug-tec") {
			const target = url.searchParams.get("url") ?? "https://thesaxonpub.com/events/";
			const results: Record<string, unknown> = { target };
			try {
				const light = await fetch(target, {
					headers: { "User-Agent": "Mozilla/5.0 events-platform-tec", Accept: "text/html,application/json" },
				});
				const lightText = await light.text();
				results.light = {
					status: light.status,
					len: lightText.length,
					tribe: /tribe-events/i.test(lightText),
					json: lightText.trimStart().startsWith("{"),
					links: [...lightText.matchAll(/\/event\/[a-z0-9-]+/gi)].slice(0, 5).map((m) => m[0]),
				};
			} catch (e) {
				results.light = { error: e instanceof Error ? e.message : String(e) };
			}
			try {
				const api =
					"https://thesaxonpub.com/wp-json/tribe/events/v1/events?per_page=3&start_date=2026-07-10";
				const apiRes = await fetch(api, {
					headers: { "User-Agent": "Mozilla/5.0 events-platform-tec", Accept: "application/json" },
				});
				const apiText = await apiRes.text();
				results.api = {
					status: apiRes.status,
					len: apiText.length,
					startsJson: apiText.trimStart().startsWith("{"),
					sample: apiText.trimStart().startsWith("{")
						? (JSON.parse(apiText).events ?? []).slice(0, 2).map((e: { title: string }) => e.title)
						: apiText.slice(0, 120),
				};
			} catch (e) {
				results.api = { error: e instanceof Error ? e.message : String(e) };
			}
			try {
				const html = await renderPageContent(env.BROWSER, target);
				results.browser = {
					len: html.length,
					tribe: /tribe-events/i.test(html),
					hasEventsJson: /"events"\s*:/.test(html),
					startsJson: html.trimStart().startsWith("{") || /<pre[^>]*>\s*\{/.test(html),
					preview: html.slice(0, 400),
					links: [...html.matchAll(/href="(https?:\/\/[^"]+\/event\/[^"]+)"/gi)]
						.slice(0, 5)
						.map((m) => m[1]),
				};
			} catch (e) {
				results.browser = { error: e instanceof Error ? e.message : String(e) };
			}
			return Response.json(results);
		}

		// Inspection only - renders a page to Markdown with no AI call, so it's
		// free to use for debugging what the extractor actually sees (e.g.
		// whether a venue's images survive the HTML->Markdown conversion).
		if (request.method === "GET" && url.pathname === "/debug-render") {
			const target = url.searchParams.get("url");
			if (!target) return Response.json({ error: "Expected ?url=" }, { status: 400 });
			const markdown = await renderMarkdown(env.BROWSER, target);
			return new Response(markdown, { headers: { "content-type": "text/plain; charset=utf-8" } });
		}

		if (request.method === "POST" && url.pathname === "/test-source") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			const payload = body as {
				calendarUrl?: string;
				feedUrl?: string | null;
				platformType?: string;
				scrapeDaysAhead?: number;
				venueName?: string;
				venueAddress?: string | null;
				venueId?: string;
				sourceId?: string;
			};

			let calendarUrl = payload.calendarUrl;
			let feedUrl = payload.feedUrl ?? null;
			let platformType = payload.platformType;
			let scrapeDaysAhead = payload.scrapeDaysAhead ?? 90;
			let venueName = payload.venueName ?? "Test Venue";
			let venueAddress = payload.venueAddress ?? null;

			if (payload.venueId) {
				const supabase = createServiceRoleClient(env);
				const { data: venue } = await supabase
					.from("venues")
					.select("name, address")
					.eq("id", payload.venueId)
					.single();
				if (venue) {
					venueName = venue.name;
					venueAddress = venue.address;
				}
				if (payload.sourceId) {
					const { data: source } = await supabase
						.from("venue_event_sources")
						.select("calendar_url, feed_url, platform_type, scrape_days_ahead")
						.eq("id", payload.sourceId)
						.single();
					if (source) {
						calendarUrl = source.calendar_url;
						feedUrl = source.feed_url;
						platformType = source.platform_type;
						scrapeDaysAhead = source.scrape_days_ahead;
					}
				}
			}

			if (!calendarUrl) {
				return Response.json({ error: "Expected calendarUrl or venueId+sourceId" }, { status: 400 });
			}

			try {
				const result = await testVenueSource({
					browser: env.BROWSER,
					calendarUrl,
					feedUrl,
					platformType: platformType as import("./lib/sources/detect-platform").PlatformType | undefined,
					scrapeDaysAhead,
					ticketmasterApiKey: env.TICKETMASTER_API_KEY ?? null,
					venueName,
					venueAddress,
				});

				if (payload.sourceId) {
					const supabase = createServiceRoleClient(env);
					await supabase
						.from("venue_event_sources")
						.update({
							feed_url: result.feed_url,
							platform_type: result.detected_platform,
							last_test_at: new Date().toISOString(),
							last_test_result: result,
							updated_at: new Date().toISOString(),
						})
						.eq("id", payload.sourceId);
				}

				return Response.json(result);
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		if (request.method === "POST" && url.pathname === "/generate-artist") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			const payload = body as {
				siteId?: string;
				bandName?: string;
				city?: string | null;
				imageUrl?: string | null;
				youtubeEmbed?: string | null;
			};

			if (!payload.siteId || !payload.bandName?.trim()) {
				return Response.json({ error: "Expected { siteId, bandName, city?, imageUrl?, youtubeEmbed? }" }, { status: 400 });
			}

			if (env.ENABLE_AUTO_ARTIST_GENERATION === "false") {
				return Response.json({ error: "Auto artist generation is disabled on this worker" }, { status: 403 });
			}

			try {
				const supabase = createServiceRoleClient(env);
				const result = await createArtistFromResearch({
					supabase,
					browser: env.BROWSER,
					ai: env.AI,
					siteId: payload.siteId,
					bandName: payload.bandName.trim(),
					city: payload.city ?? null,
					imageUrl: payload.imageUrl ?? null,
					youtubeEmbed: payload.youtubeEmbed ?? null,
				});

				if (!result) {
					return Response.json({ error: "Failed to create artist" }, { status: 500 });
				}

				return Response.json(result);
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		// Collapse duplicate pending ingested_events (within-batch / same-show doubles).
		// Optional body: { venueId?: string }
		if (request.method === "POST" && url.pathname === "/dedupe-pending") {
			let venueId: string | undefined;
			try {
				const body = (await request.json()) as { venueId?: string };
				if (typeof body.venueId === "string" && body.venueId.length > 0) {
					venueId = body.venueId;
				}
			} catch {
				// empty body is fine — collapse all venues
			}
			try {
				const supabase = createServiceRoleClient(env);
				const result = await collapsePendingIngestedDuplicates(supabase, venueId);
				return Response.json({ ok: true, ...result, venueId: venueId ?? null });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		if (request.method === "POST" && url.pathname === "/ingest") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			const payload = body as { venueId?: unknown; sourceId?: unknown };
			const venueId = payload.venueId;
			if (typeof venueId !== "string" || venueId.length === 0) {
				return Response.json({ error: "Expected { venueId: string, sourceId?: string }" }, { status: 400 });
			}
			const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : undefined;

			const instance = await env.VENUE_INGESTION_WORKFLOW.create({ params: { venueId, sourceId } });
			return Response.json({ instanceId: instance.id, status: await instance.status() });
		}

		if (request.method === "POST" && url.pathname === "/ingest-all") {
			const instance = await env.SCHEDULER_WORKFLOW.create();
			return Response.json({ instanceId: instance.id, status: await instance.status() });
		}

		if (request.method === "GET" && url.pathname.startsWith("/ingest-all/")) {
			const instanceId = url.pathname.slice("/ingest-all/".length);
			try {
				const instance = await env.SCHEDULER_WORKFLOW.get(instanceId);
				return Response.json({ instanceId: instance.id, status: await instance.status() });
			} catch {
				return Response.json({ error: "Instance not found" }, { status: 404 });
			}
		}

		if (request.method === "GET" && url.pathname.startsWith("/ingest/")) {
			const instanceId = url.pathname.slice("/ingest/".length);
			try {
				const instance = await env.VENUE_INGESTION_WORKFLOW.get(instanceId);
				return Response.json({ instanceId: instance.id, status: await instance.status() });
			} catch {
				return Response.json({ error: "Instance not found" }, { status: 404 });
			}
		}

		return new Response("Not found", { status: 404 });
	},

	async scheduled(_controller: ScheduledController, env: CloudflareEnv): Promise<void> {
		await env.SCHEDULER_WORKFLOW.create();
	},
} satisfies ExportedHandler<CloudflareEnv>;
