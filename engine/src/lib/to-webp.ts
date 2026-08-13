/**
 * Convert image bytes to WebP for storage (Cloudflare Workers–safe WASM codecs).
 * Never shrink below 1500×1000 product floor.
 */

export const MIN_IMAGE_WIDTH = 1500;
export const MIN_IMAGE_HEIGHT = 1000;
const MAX_LONG_EDGE = 2400;
const WEBP_QUALITY = 80;

export type WebpConvertResult = {
	bytes: ArrayBuffer;
	contentType: "image/webp";
	width: number;
	height: number;
	converted: boolean;
};

function detectFormat(
	bytes: ArrayBuffer,
	contentType?: string | null,
): "jpeg" | "png" | "webp" | "gif" | "unknown" {
	const u8 = new Uint8Array(bytes);
	if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return "jpeg";
	if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
		return "png";
	}
	if (
		u8.length >= 12 &&
		u8[0] === 0x52 &&
		u8[1] === 0x49 &&
		u8[2] === 0x46 &&
		u8[3] === 0x46 &&
		u8[8] === 0x57 &&
		u8[9] === 0x45 &&
		u8[10] === 0x42 &&
		u8[11] === 0x50
	) {
		return "webp";
	}
	if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return "gif";
	const ct = (contentType || "").toLowerCase();
	if (ct.includes("jpeg") || ct.includes("jpg")) return "jpeg";
	if (ct.includes("png")) return "png";
	if (ct.includes("webp")) return "webp";
	if (ct.includes("gif")) return "gif";
	return "unknown";
}

type RgbaImage = { data: Uint8ClampedArray; width: number; height: number };

function resizeIfAllowed(image: RgbaImage): RgbaImage {
	const { width, height, data } = image;
	if (width <= 0 || height <= 0) return image;

	const longEdge = Math.max(width, height);
	if (longEdge <= MAX_LONG_EDGE) return image;
	if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) return image;

	let scale = MAX_LONG_EDGE / longEdge;
	let tw = Math.max(1, Math.round(width * scale));
	let th = Math.max(1, Math.round(height * scale));

	if (tw < MIN_IMAGE_WIDTH || th < MIN_IMAGE_HEIGHT) {
		const scaleW = MIN_IMAGE_WIDTH / width;
		const scaleH = MIN_IMAGE_HEIGHT / height;
		scale = Math.max(scaleW, scaleH);
		if (scale >= 1) return image;
		tw = Math.max(1, Math.round(width * scale));
		th = Math.max(1, Math.round(height * scale));
	}

	if (tw >= width && th >= height) return image;

	const out = new Uint8ClampedArray(tw * th * 4);
	for (let y = 0; y < th; y++) {
		const sy = Math.min(height - 1, Math.floor((y + 0.5) * (height / th)));
		for (let x = 0; x < tw; x++) {
			const sx = Math.min(width - 1, Math.floor((x + 0.5) * (width / tw)));
			const si = (sy * width + sx) * 4;
			const di = (y * tw + x) * 4;
			out[di] = data[si];
			out[di + 1] = data[si + 1];
			out[di + 2] = data[si + 2];
			out[di + 3] = data[si + 3];
		}
	}
	return { data: out, width: tw, height: th };
}

export async function convertImageBytesToWebp(
	bytes: ArrayBuffer,
	contentType?: string | null,
): Promise<WebpConvertResult> {
	const format = detectFormat(bytes, contentType);
	if (format === "gif") {
		throw new Error("GIF conversion not supported — use JPEG/PNG/WebP");
	}
	if (format === "unknown") {
		throw new Error("Unrecognized image format");
	}

	let imageData: RgbaImage;
	if (format === "jpeg") {
		const decode = (await import("@jsquash/jpeg/decode")).default;
		const img = await decode(bytes);
		imageData = { data: img.data, width: img.width, height: img.height };
	} else if (format === "png") {
		const decode = (await import("@jsquash/png/decode")).default;
		const img = await decode(bytes);
		imageData = { data: img.data, width: img.width, height: img.height };
	} else {
		const decode = (await import("@jsquash/webp/decode")).default;
		const img = await decode(bytes);
		imageData = { data: img.data, width: img.width, height: img.height };
	}

	const resized = resizeIfAllowed(imageData);
	const needsResize =
		resized.width !== imageData.width || resized.height !== imageData.height;

	if (format === "webp" && !needsResize && bytes.byteLength <= 1_200_000) {
		return {
			bytes,
			contentType: "image/webp",
			width: imageData.width,
			height: imageData.height,
			converted: false,
		};
	}

	const encode = (await import("@jsquash/webp/encode")).default;
	const encoded = await encode(
		{
			data: resized.data,
			width: resized.width,
			height: resized.height,
		} as Parameters<typeof encode>[0],
		{ quality: WEBP_QUALITY },
	);

	return {
		bytes: encoded,
		contentType: "image/webp",
		width: resized.width,
		height: resized.height,
		converted: true,
	};
}
