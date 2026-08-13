/**
 * Restore full Germania posters (no right-half crop).
 * Uses source_image_url when present; rehosts to Supabase HTTPS.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const env = Object.fromEntries(
	readFileSync("./.dev.vars", "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = "event-media";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

function fetchable(url) {
	if (!url) return null;
	if (/rackcdn\.com/i.test(url)) return url.replace(/^https:\/\//i, "http://");
	return url;
}

async function rehost(siteId, alt, imageUrl) {
	const u = fetchable(imageUrl);
	if (!u) return null;
	const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "image/*" }, redirect: "follow" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const contentType = r.headers.get("content-type") ?? "image/jpeg";
	const ext = contentType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ?? "jpg";
	const bytes = await r.arrayBuffer();
	const path = `${siteId}/germania/full/${randomUUID()}.${ext}`;
	const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
	if (error) throw new Error(error.message);
	const {
		data: { publicUrl },
	} = sb.storage.from(BUCKET).getPublicUrl(path);
	return publicUrl;
}

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id")
	.eq("site_id", site.id)
	.eq("slug", "germania-insurance-amphitheater")
	.single();

const { data: rows } = await sb
	.from("ingested_events")
	.select("id, raw_title, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending");

console.log("pending", rows?.length ?? 0);
let ok = 0;
for (const row of rows ?? []) {
	const payload = row.raw_payload || {};
	const src = payload.source_image_url || payload.image_url;
	if (!src) continue;
	const isHalfCrop =
		payload.image_crop === "right-half" || /crop-right/i.test(payload.image_url || "");
	if (!isHalfCrop && payload.image_crop === "none") {
		console.log("· already full", row.raw_title.slice(0, 35));
		continue;
	}
	// Prefer original rackcdn / source; fall back to current URL
	const origin = payload.source_image_url || src;
	try {
		console.log("→", row.raw_title.slice(0, 40));
		const publicUrl = await rehost(site.id, row.raw_title, origin);
		const next = {
			...payload,
			image_url: publicUrl,
			source_image_url: payload.source_image_url || origin,
			image_crop: "none",
			image_crop_meta: null,
		};
		await sb.from("ingested_events").update({ raw_payload: next }).eq("id", row.id);
		console.log("  ✓ full image");
		ok++;
	} catch (e) {
		console.log("  ✗", e.message);
	}
}
console.log("Done", ok);
