import type { SupabaseClient } from "@supabase/supabase-js";
import { convertImageBytesToWebp } from "./to-webp";

const IMAGE_BUCKET = "event-media";

export function slugifyArtist(text: string): string {
	return text
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 90);
}

/** Re-host a remote image as WebP in Supabase Storage; returns media id or null on failure. */
export async function uploadImage(
	supabase: SupabaseClient,
	siteId: string,
	altText: string,
	imageUrl: string,
): Promise<string | null> {
	try {
		const response = await fetch(imageUrl);
		if (!response.ok) return null;

		const contentType = response.headers.get("content-type") ?? "image/jpeg";
		if (!contentType.startsWith("image/") && !/\.(jpe?g|png|webp)(\?|$)/i.test(imageUrl)) {
			return null;
		}
		const rawBytes = await response.arrayBuffer();
		if (!rawBytes.byteLength) return null;

		let uploadBytes: ArrayBuffer;
		let uploadType: string;
		let width: number | null = null;
		let height: number | null = null;
		try {
			const webp = await convertImageBytesToWebp(rawBytes, contentType);
			uploadBytes = webp.bytes;
			uploadType = webp.contentType;
			width = webp.width;
			height = webp.height;
		} catch {
			// Fallback: store original (prefer still ingesting over dropping image)
			uploadBytes = rawBytes;
			uploadType = contentType.startsWith("image/") ? contentType.split(";")[0]! : "image/jpeg";
		}

		const ext = uploadType.includes("webp")
			? "webp"
			: uploadType.includes("png")
				? "png"
				: "jpg";
		const path = `${siteId}/${crypto.randomUUID()}.${ext}`;

		const { error: uploadError } = await supabase.storage
			.from(IMAGE_BUCKET)
			.upload(path, uploadBytes, { contentType: uploadType, upsert: false });
		if (uploadError) return null;

		const {
			data: { publicUrl },
		} = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);

		const insert: Record<string, unknown> = {
			site_id: siteId,
			storage_path: publicUrl,
			alt_text: altText,
		};
		if (width != null) insert.width = width;
		if (height != null) insert.height = height;

		const { data: mediaRow, error: mediaError } = await supabase
			.from("media")
			.insert(insert)
			.select("id")
			.single();
		if (mediaError || !mediaRow) return null;

		return mediaRow.id as string;
	} catch {
		return null;
	}
}
