/**
 * Import Lake Travis venues from Listar place API → events-platform site `laketravis`.
 *
 * READ-ONLY against live WP. Writes only to our Supabase.
 *
 *   node apps/ingestion/scripts/import-listar-laketravis-venues.mjs --dry-run
 *   node apps/ingestion/scripts/import-listar-laketravis-venues.mjs --limit=10
 *   node apps/ingestion/scripts/import-listar-laketravis-venues.mjs --enrich-view --with-reviews
 *   node apps/ingestion/scripts/import-listar-laketravis-venues.mjs --with-seo
 *
 * Requires schema 044_venue_listar_place_fields.sql applied for opening_hours etc.
 * Falls back if columns missing.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");

// Dynamic import of TS source via tsx-less: reimplement thin map using fetch
// (script stays plain ESM for node without ts-node)

const ORIGIN = "https://laketravis.com";
const SITE_SLUG = "laketravis";
const SOURCE = "laketravis_listar";

function loadEnv() {
	const env = { ...process.env };
	for (const f of [
		path.join(ROOT, "apps/ingestion/.dev.vars"),
		path.join(ROOT, "apps/admin/.env.local"),
	]) {
		if (!fs.existsSync(f)) continue;
		for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
			if (!line || line.startsWith("#") || !line.includes("=")) continue;
			const i = line.indexOf("=");
			const k = line.slice(0, i).trim();
			let v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
			if (k && env[k] === undefined) env[k] = v;
		}
	}
	return env;
}

function arg(name) {
	const p = process.argv.find((a) => a.startsWith(`--${name}=`));
	return p ? p.slice(name.length + 3) : null;
}
function hasFlag(name) {
	return process.argv.includes(`--${name}`);
}

function stripHtml(html) {
	if (!html) return "";
	return String(html)
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#038;/g, "&")
		.replace(/&#039;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchJson(url) {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 events-platform-lt-import",
			Accept: "application/json",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

async function allPlaces(limit) {
	const out = [];
	let maxPage = 1;
	for (let page = 1; page <= 300; page++) {
		const body = await fetchJson(
			`${ORIGIN}/wp-json/listar/v1/place/list?page=${page}&per_page=50`,
		);
		if (body.pagination?.max_page) maxPage = body.pagination.max_page;
		const batch = body.data || [];
		console.log(`  list page ${page}/${maxPage} (+${batch.length})`);
		out.push(...batch);
		if (limit && out.length >= limit) return out.slice(0, limit);
		if (!batch.length || page >= maxPage) break;
	}
	return out;
}

async function placeView(id) {
	const body = await fetchJson(`${ORIGIN}/wp-json/listar/v1/place/view?id=${id}`);
	return body.data || null;
}

function mapPlace(p) {
	const id = String(p.ID ?? p.id ?? "");
	const name = stripHtml(p.post_title || "");
	if (!id || !name) return null;
	const slug = (p.post_name || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 80);
	const social = {};
	for (const [k, v] of Object.entries(p.social_network || {})) {
		if (typeof v === "string" && v.startsWith("http")) social[k] = v;
	}
	const lat = p.latitude != null && p.latitude !== "" ? Number(p.latitude) : null;
	const lng = p.longitude != null && p.longitude !== "" ? Number(p.longitude) : null;
	return {
		external_place_id: id,
		slug,
		name,
		description: stripHtml(p.post_content || "") || null,
		address: p.address || null,
		lat: Number.isFinite(lat) ? lat : null,
		lng: Number.isFinite(lng) ? lng : null,
		phone: p.phone || null,
		email: typeof p.email === "string" && p.email.includes("@") ? p.email : null,
		website_url: typeof p.website === "string" && p.website.startsWith("http") ? p.website : null,
		listing_url: p.guid?.startsWith("http") ? p.guid : null,
		rating_avg: Number(p.rating_avg) || 0,
		rating_count: Number(p.rating_count) || 0,
		status: (p.post_status || "publish") === "publish" ? "published" : "draft",
		image_url: p.image?.full?.url || p.image?.medium?.url || null,
		category_slug: p.category?.slug || null,
		category_name: p.category?.name || null,
		opening_hours: Array.isArray(p.opening_hour) ? p.opening_hour : [],
		google_place_id: p._google_place_id || null,
		zip_code: p.zip_code || null,
		price_range: [p.price_min, p.price_max].filter(Boolean).join("–") || null,
		social_links: social,
		keywords: p.keywords || null,
	};
}

function slugify(s) {
	return s
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 80);
}

const dryRun = hasFlag("dry-run") || !hasFlag("confirm");
const limit = arg("limit") ? Number(arg("limit")) : null;
const enrichView = hasFlag("enrich-view");
const withReviews = hasFlag("with-reviews");
const withSeo = hasFlag("with-seo");

console.log("=== Lake Travis Listar → venues ===");
console.log(`Mode: ${dryRun ? "DRY-RUN (pass --confirm to write)" : "WRITE"}`);
console.log({ limit, enrichView, withReviews, withSeo });

const env = loadEnv();
const sb = createClient(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: site, error: siteErr } = await sb
	.from("sites")
	.select("id, slug, name")
	.eq("slug", SITE_SLUG)
	.maybeSingle();
if (siteErr || !site) {
	console.error("Site laketravis not found", siteErr?.message);
	process.exit(1);
}
console.log("Site:", site.name, site.id);

// categories + regions for site
const { data: cats } = await sb
	.from("categories")
	.select("id, slug, name, kind")
	.eq("site_id", site.id)
	.eq("kind", "venue");
const catBySlug = Object.fromEntries((cats || []).map((c) => [c.slug, c]));
const { data: regions } = await sb.from("regions").select("id, slug, name").eq("site_id", site.id);
const regionBySlug = Object.fromEntries((regions || []).map((r) => [r.slug, r]));
// WP term id → region (filled when we have region list from API later)
const regionByWpId = {};

console.log("LT categories loaded:", Object.keys(catBySlug).length, "regions:", Object.keys(regionBySlug).length);

console.log("\nFetching Listar places…");
const places = await allPlaces(limit);
console.log("places", places.length);

let created = 0;
let updated = 0;
let skipped = 0;
let failed = 0;
const report = [];

for (const raw of places) {
	let p = raw;
	const pid = String(raw.ID ?? raw.id ?? "");
	if (enrichView && pid) {
		try {
			const view = await placeView(pid);
			if (view) p = { ...raw, ...view };
		} catch (e) {
			console.warn("view fail", pid, e.message);
		}
	}
	const m = mapPlace(p);
	if (!m) {
		skipped++;
		continue;
	}

	// ensure unique slug
	let slug = m.slug || slugify(m.name);
	const label = `${m.external_place_id} ${m.name}`;

	if (dryRun) {
		console.log(
			`  DRY  ${label}  | ${m.address?.slice(0, 40) || "no-addr"} | ★${m.rating_avg}(${m.rating_count}) | cat=${m.category_slug || "—"}`,
		);
		report.push(m);
		created++;
		continue;
	}

	const { data: existing } = await sb
		.from("venues")
		.select("id, slug")
		.eq("site_id", site.id)
		.eq("external_place_id", m.external_place_id)
		.maybeSingle();

	const base = {
		site_id: site.id,
		name: m.name,
		description: m.description,
		address: m.address,
		lat: m.lat,
		lng: m.lng,
		phone: m.phone,
		website_url: m.website_url,
		rating_avg: m.rating_avg,
		rating_count: m.rating_count,
		status: m.status,
		social_links: m.social_links,
		external_place_id: m.external_place_id,
		updated_at: new Date().toISOString(),
	};

	// Optional Listar columns (044) — ignore if missing
	const extended = {
		...base,
		opening_hours: m.opening_hours,
		google_place_id: m.google_place_id,
		email: m.email,
		zip_code: m.zip_code,
		price_range: m.price_range,
	};

	let venueId = existing?.id || null;

	if (existing) {
		let { error } = await sb.from("venues").update(extended).eq("id", existing.id);
		if (error && /column|schema/i.test(error.message)) {
			({ error } = await sb.from("venues").update(base).eq("id", existing.id));
		}
		if (error) {
			console.log("FAIL update", label, error.message);
			failed++;
			continue;
		}
		updated++;
		console.log("UPD", label);
	} else {
		// slug collision
		for (let i = 0; i < 50; i++) {
			const trySlug = i === 0 ? slug : `${slug}-${i + 1}`;
			const { data: hit } = await sb
				.from("venues")
				.select("id")
				.eq("site_id", site.id)
				.eq("slug", trySlug)
				.maybeSingle();
			if (!hit) {
				slug = trySlug;
				break;
			}
		}
		const insertRow = { ...extended, slug, created_at: new Date().toISOString() };
		let { data: row, error } = await sb.from("venues").insert(insertRow).select("id").single();
		if (error && /column|schema/i.test(error.message)) {
			({ data: row, error } = await sb
				.from("venues")
				.insert({ ...base, slug, created_at: new Date().toISOString() })
				.select("id")
				.single());
		}
		if (error) {
			console.log("FAIL insert", label, error.message);
			failed++;
			continue;
		}
		venueId = row.id;
		created++;
		console.log("NEW", label, slug);
	}

	// category link
	if (venueId && m.category_slug && catBySlug[m.category_slug]) {
		await sb.from("venue_categories").upsert(
			{ venue_id: venueId, category_id: catBySlug[m.category_slug].id },
			{ onConflict: "venue_id,category_id" },
		);
	}

	// SEO + region + calendar_url from WP REST (always when writing; cheap enough)
	if (venueId && pid && (withSeo || !dryRun)) {
		try {
			const jl = await fetchJson(`${ORIGIN}/wp-json/wp/v2/job_listing/${pid}`);
			const y = jl.yoast_head_json || {};
			const patch = {
				updated_at: new Date().toISOString(),
			};
			if (jl.link) {
				patch.calendar_url = jl.link;
				// listing page also useful as default calendar for LT directory venues
			}
			if (withSeo) {
				patch.seo_title = y.title || null;
				patch.seo_description = y.description || null;
				patch.canonical_url = y.canonical || jl.link || null;
				patch.og_title = y.og_title || null;
				patch.og_description = y.og_description || null;
				patch.og_image_url = y.og_image?.[0]?.url || null;
			}
			// region term IDs on job_listing
			const regionTermIds = jl.job_listing_region || [];
			if (regionTermIds.length && Object.keys(regionByWpId).length === 0) {
				// lazy load region map once
				const regRes = await fetch(
					`${ORIGIN}/wp-json/wp/v2/job_listing_region?per_page=100`,
					{ headers: { Accept: "application/json" } },
				);
				const regList = await regRes.json();
				for (const r of regList || []) {
					regionByWpId[r.id] = r.slug;
				}
			}
			if (regionTermIds.length) {
				const rslug = regionByWpId[regionTermIds[0]];
				if (rslug && regionBySlug[rslug]) patch.region_id = regionBySlug[rslug].id;
			}
			// more categories from WP
			const catTermIds = jl["job-categories"] || [];
			if (catTermIds.length && venueId) {
				// map via class_list slugs on jl
				const classList = jl.class_list || [];
				for (const cls of classList) {
					const mcat = String(cls).match(/^job_listing_category-(.+)$/);
					if (mcat && catBySlug[mcat[1]]) {
						await sb.from("venue_categories").upsert(
							{ venue_id: venueId, category_id: catBySlug[mcat[1]].id },
							{ onConflict: "venue_id,category_id" },
						);
					}
				}
			}
			await sb.from("venues").update(patch).eq("id", venueId);
		} catch (e) {
			console.warn("seo/region fail", pid, e.message);
		}
	}

	// Reviews
	if (withReviews && venueId && pid) {
		try {
			const body = await fetchJson(`${ORIGIN}/wp-json/listar/v1/comments?post_id=${pid}`);
			for (const c of body.data || []) {
				const rid = String(c.comment_ID || "");
				if (!rid) continue;
				const row = {
					site_id: site.id,
					venue_id: venueId,
					source: SOURCE,
					source_review_id: rid,
					author_name: (c.comment_author || "Anonymous").trim() || "Anonymous",
					author_url: c.comment_author_url || null,
					rating: Math.min(5, Math.max(1, Number(c.rate) || 5)),
					body: stripHtml(c.comment_content || ""),
					reviewed_at: c.comment_date_gmt
						? new Date(c.comment_date_gmt.replace(" ", "T") + "Z").toISOString()
						: new Date().toISOString(),
					status: "published",
					updated_at: new Date().toISOString(),
				};
				await sb.from("venue_reviews").upsert(row, { onConflict: "source,source_review_id" });
			}
		} catch (e) {
			console.warn("reviews fail", pid, e.message);
		}
	}
}

const outDir = path.join(ROOT, "tmp-enhance", "laketravis");
fs.mkdirSync(outDir, { recursive: true });
if (dryRun) {
	fs.writeFileSync(path.join(outDir, "venues-dry-run.json"), JSON.stringify(report, null, 2));
	console.log("\nwrote", path.join(outDir, "venues-dry-run.json"));
}

console.log(`\nDone. created/dry=${created} updated=${updated} skipped=${skipped} failed=${failed}`);
if (dryRun) console.log("Re-run with --confirm to write to Supabase.");
