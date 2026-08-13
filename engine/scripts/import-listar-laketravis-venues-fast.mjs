/**
 * Fast resume: only NEW Lake Travis Listar places (skip existing external_place_id).
 * Parallel batches. Full enrich + reviews + SEO for new rows.
 *
 *   node apps/ingestion/scripts/import-listar-laketravis-venues-fast.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const ORIGIN = "https://laketravis.com";
const SITE_SLUG = "laketravis";
const SOURCE = "laketravis_listar";
const CONCURRENCY = 6;

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

function stripHtml(html) {
	if (!html) return "";
	return String(html)
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#038;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchJson(url) {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 events-platform-lt-import-fast",
			Accept: "application/json",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

async function mapPool(items, limit, fn) {
	const ret = [];
	let i = 0;
	async function worker() {
		while (i < items.length) {
			const idx = i++;
			ret[idx] = await fn(items[idx], idx);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return ret;
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
		rating_avg: Number(p.rating_avg) || 0,
		rating_count: Number(p.rating_count) || 0,
		status: (p.post_status || "publish") === "publish" ? "published" : "draft",
		opening_hours: Array.isArray(p.opening_hour) ? p.opening_hour : [],
		google_place_id: p._google_place_id || null,
		zip_code: p.zip_code || null,
		price_range: [p.price_min, p.price_max].filter(Boolean).join("–") || null,
		social_links: social,
		category_slug: p.category?.slug || null,
	};
}

const env = loadEnv();
const sb = createClient(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: site } = await sb.from("sites").select("id,slug,name").eq("slug", SITE_SLUG).single();
console.log("Site", site.name, site.id);

const { data: cats } = await sb
	.from("categories")
	.select("id, slug")
	.eq("site_id", site.id)
	.eq("kind", "venue");
const catBySlug = Object.fromEntries((cats || []).map((c) => [c.slug, c]));
const { data: regions } = await sb.from("regions").select("id, slug").eq("site_id", site.id);
const regionBySlug = Object.fromEntries((regions || []).map((r) => [r.slug, r]));

// existing external ids
const existingIds = new Set();
for (let from = 0; ; from += 1000) {
	const { data } = await sb
		.from("venues")
		.select("external_place_id")
		.eq("site_id", site.id)
		.not("external_place_id", "is", null)
		.range(from, from + 999);
	if (!data?.length) break;
	for (const r of data) if (r.external_place_id) existingIds.add(String(r.external_place_id));
	if (data.length < 1000) break;
}
console.log("Already imported:", existingIds.size);

// list all places
const places = [];
let maxPage = 1;
for (let page = 1; page <= 20; page++) {
	const body = await fetchJson(`${ORIGIN}/wp-json/listar/v1/place/list?page=${page}&per_page=50`);
	if (body.pagination?.max_page) maxPage = body.pagination.max_page;
	const batch = body.data || [];
	places.push(...batch);
	console.log(`list ${page}/${maxPage} total=${places.length}`);
	if (!batch.length || page >= maxPage) break;
}

const todo = places.filter((p) => !existingIds.has(String(p.ID ?? p.id)));
console.log("Remaining to import:", todo.length, "of", places.length);

// region id map from WP once
const regionByWpId = {};
{
	const regList = await fetchJson(`${ORIGIN}/wp-json/wp/v2/job_listing_region?per_page=100`);
	for (const r of regList || []) regionByWpId[r.id] = r.slug;
}

let created = 0;
let failed = 0;

await mapPool(todo, CONCURRENCY, async (raw) => {
	const pid = String(raw.ID ?? raw.id ?? "");
	try {
		const view = await fetchJson(`${ORIGIN}/wp-json/listar/v1/place/view?id=${pid}`);
		const p = { ...raw, ...(view.data || {}) };
		const m = mapPlace(p);
		if (!m) {
			failed++;
			return;
		}

		let slug = m.slug;
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

		const row = {
			site_id: site.id,
			slug,
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
			opening_hours: m.opening_hours,
			google_place_id: m.google_place_id,
			email: m.email,
			zip_code: m.zip_code,
			price_range: m.price_range,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		// WP SEO + region
		try {
			const jl = await fetchJson(`${ORIGIN}/wp-json/wp/v2/job_listing/${pid}`);
			const y = jl.yoast_head_json || {};
			row.calendar_url = jl.link || null;
			row.seo_title = y.title || null;
			row.seo_description = y.description || null;
			row.canonical_url = y.canonical || jl.link || null;
			row.og_title = y.og_title || null;
			row.og_description = y.og_description || null;
			row.og_image_url = y.og_image?.[0]?.url || null;
			const rids = jl.job_listing_region || [];
			if (rids[0] && regionByWpId[rids[0]] && regionBySlug[regionByWpId[rids[0]]]) {
				row.region_id = regionBySlug[regionByWpId[rids[0]]].id;
			}
			// categories from class_list
			var classList = jl.class_list || [];
		} catch {
			var classList = [];
		}

		const { data: inserted, error } = await sb.from("venues").insert(row).select("id").single();
		if (error) {
			console.log("FAIL", pid, m.name, error.message);
			failed++;
			return;
		}
		const venueId = inserted.id;

		if (m.category_slug && catBySlug[m.category_slug]) {
			await sb.from("venue_categories").upsert(
				{ venue_id: venueId, category_id: catBySlug[m.category_slug].id },
				{ onConflict: "venue_id,category_id" },
			);
		}
		for (const cls of classList) {
			const mcat = String(cls).match(/^job_listing_category-(.+)$/);
			if (mcat && catBySlug[mcat[1]]) {
				await sb.from("venue_categories").upsert(
					{ venue_id: venueId, category_id: catBySlug[mcat[1]].id },
					{ onConflict: "venue_id,category_id" },
				);
			}
		}

		// reviews
		try {
			const body = await fetchJson(`${ORIGIN}/wp-json/listar/v1/comments?post_id=${pid}`);
			const reviews = [];
			for (const c of body.data || []) {
				const rid = String(c.comment_ID || "");
				if (!rid) continue;
				reviews.push({
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
				});
			}
			if (reviews.length) {
				// chunk upsert
				for (let i = 0; i < reviews.length; i += 50) {
					await sb
						.from("venue_reviews")
						.upsert(reviews.slice(i, i + 50), { onConflict: "source,source_review_id" });
				}
			}
		} catch (e) {
			console.warn("reviews", pid, e.message);
		}

		created++;
		if (created % 10 === 0) console.log(`… ${created}/${todo.length} new`);
		else console.log("NEW", pid, m.name);
	} catch (e) {
		console.log("FAIL", pid, e.message);
		failed++;
	}
});

const { count: vCount } = await sb
	.from("venues")
	.select("id", { count: "exact", head: true })
	.eq("site_id", site.id);
const { count: rCount } = await sb
	.from("venue_reviews")
	.select("id", { count: "exact", head: true })
	.eq("site_id", site.id);

console.log(`\nDone. new=${created} failed=${failed}`);
console.log(`Lake Travis totals: venues=${vCount} reviews=${rCount}`);
