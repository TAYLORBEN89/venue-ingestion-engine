/**
 * Shared Listar REST client (Lake Travis, HeyAustin, Crested Butte mobile backends).
 * Read-only against live WordPress — never POST to place/save, event/save, etc.
 */

export const LISTAR_ORIGINS = {
	laketravis: "https://laketravis.com",
	heyaustin: "https://heyaustin.com",
	heycrestedbutte: "https://heycrestedbutte.com",
} as const;

export type ListarBrand = keyof typeof LISTAR_ORIGINS;

export interface ListarPagination {
	page: number;
	per_page: number;
	max_page: number;
	total: number;
}

export interface ListarImage {
	id?: number;
	full?: { url?: string };
	medium?: { url?: string };
	thumb?: { url?: string };
}

export interface ListarCategory {
	term_id?: number;
	name?: string;
	slug?: string;
	taxonomy?: string;
	parent?: number;
	description?: string;
	count?: number;
}

export interface ListarOpeningDay {
	label?: string;
	key?: string;
	day_of_week?: number;
	schedule?: Array<{ start?: string; end?: string }>;
}

export interface ListarPlace {
	ID?: number | string;
	id?: number | string;
	post_title?: string;
	post_name?: string;
	post_content?: string;
	post_status?: string;
	post_type?: string;
	guid?: string;
	address?: string;
	phone?: string;
	website?: string;
	email?: string | null | Record<string, unknown>;
	latitude?: string | number;
	longitude?: string | number;
	zip_code?: string;
	rating_avg?: number;
	rating_count?: number;
	rating_meta?: Record<string, number>;
	image?: ListarImage;
	category?: ListarCategory;
	opening_hour?: ListarOpeningDay[];
	social_network?: Record<string, string | null | undefined>;
	_google_place_id?: string;
	_company_video?: string;
	video_url?: string;
	keywords?: string;
	price_min?: string;
	price_max?: string;
	galleries?: unknown[];
	gallery?: string;
	city_name?: string;
	state_name?: string;
	country_name?: string;
	comment_count?: string | number;
	wishlist?: boolean;
	[key: string]: unknown;
}

export interface ListarEvent {
	ID?: string | number;
	id?: string | number;
	post_title?: string;
	post_content?: string;
	post_name?: string;
	guid?: string;
	event_starts_sort_field?: string;
	venue_name?: string;
	venue_website?: string;
	venue_phone?: string;
	venue_desc?: string;
	facebook?: string;
	fb_event_uri?: string;
	image?: ListarImage;
	[key: string]: unknown;
}

export interface ListarListResponse<T> {
	success?: boolean;
	pagination?: ListarPagination;
	data?: T[];
	ai_ids?: unknown;
}

export interface ListarViewResponse<T> {
	success?: boolean;
	data?: T;
}

export interface ListarComment {
	comment_ID?: string;
	comment_post_ID?: string;
	comment_author?: string;
	comment_author_url?: string;
	comment_content?: string;
	comment_date?: string;
	comment_date_gmt?: string;
	rate?: number | string;
	comment_author_image?: string;
	[key: string]: unknown;
}

export interface ListarCommentsResponse {
	success?: boolean;
	attr?: {
		rating?: {
			rating_avg?: number;
			rating_count?: number;
			rating_meta?: Record<string, number>;
		};
	};
	data?: ListarComment[];
}

const UA = "Mozilla/5.0 events-platform-listar-client (read-only)";

export async function listarFetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "application/json",
		},
	});
	if (!res.ok) throw new Error(`Listar HTTP ${res.status} ${url}`);
	return (await res.json()) as T;
}

export function listarOrigin(brand: ListarBrand | string): string {
	if (brand in LISTAR_ORIGINS) return LISTAR_ORIGINS[brand as ListarBrand];
	if (/^https?:\/\//i.test(brand)) return brand.replace(/\/$/, "");
	throw new Error(`Unknown Listar brand/origin: ${brand}`);
}

export async function listarPlaceList(
	origin: string,
	page = 1,
	perPage = 50,
): Promise<ListarListResponse<ListarPlace>> {
	const url = `${origin}/wp-json/listar/v1/place/list?page=${page}&per_page=${perPage}`;
	return listarFetchJson(url);
}

export async function listarPlaceView(origin: string, id: string | number): Promise<ListarPlace | null> {
	const url = `${origin}/wp-json/listar/v1/place/view?id=${id}`;
	const body = await listarFetchJson<ListarViewResponse<ListarPlace>>(url);
	return body.data ?? null;
}

export async function listarEventList(
	origin: string,
	page = 1,
	perPage = 70,
): Promise<ListarListResponse<ListarEvent>> {
	const url = `${origin}/wp-json/listar/v1/event/list?page=${page}&per_page=${perPage}`;
	return listarFetchJson(url);
}

export async function listarCategoryList(origin: string): Promise<ListarCategory[]> {
	const body = await listarFetchJson<{ success?: boolean; data?: ListarCategory[] }>(
		`${origin}/wp-json/listar/v1/category/list`,
	);
	return body.data ?? [];
}

export async function listarComments(
	origin: string,
	postId: string | number,
): Promise<ListarCommentsResponse> {
	return listarFetchJson(`${origin}/wp-json/listar/v1/comments?post_id=${postId}`);
}

/** Paginate place/list until max_page (or maxPages cap). */
export async function listarAllPlaces(
	origin: string,
	opts?: { perPage?: number; maxPages?: number; onPage?: (page: number, max: number, n: number) => void },
): Promise<ListarPlace[]> {
	const perPage = opts?.perPage ?? 50;
	const maxPages = opts?.maxPages ?? 500;
	const out: ListarPlace[] = [];
	let maxPage = 1;
	for (let page = 1; page <= maxPages; page++) {
		const body = await listarPlaceList(origin, page, perPage);
		if (body.pagination?.max_page) maxPage = body.pagination.max_page;
		const batch = body.data ?? [];
		opts?.onPage?.(page, maxPage, batch.length);
		out.push(...batch);
		if (batch.length === 0 || page >= maxPage) break;
	}
	return out;
}

export function stripListarHtml(html: string | null | undefined): string {
	if (!html) return "";
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h\d|li)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#038;/g, "&")
		.replace(/&#039;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/\s+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+/g, " ")
		.trim();
}

export function listarPlaceId(p: ListarPlace): string {
	return String(p.ID ?? p.id ?? "");
}

export function listarNum(v: unknown): number | null {
	if (v == null || v === "") return null;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : null;
}

export function listarEmail(v: unknown): string | null {
	if (typeof v === "string" && v.includes("@")) return v.trim();
	return null;
}

export function listarImageUrl(image?: ListarImage | null): string | null {
	return image?.full?.url || image?.medium?.url || image?.thumb?.url || null;
}
