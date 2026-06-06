export class HttpError extends Error {
	constructor(public status: number, public body: string) {
		super(`HTTP ${status}: ${body}`);
	}
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(path, {
		credentials: "include",
		...init,
		headers: {
			"content-type": "application/json",
			...(init.headers || {}),
		},
	});
	if (res.status === 401) {
		const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
		window.location.href = `/login?next=${next}`;
		throw new HttpError(401, "unauthorized");
	}
	const text = await res.text();
	if (!res.ok) throw new HttpError(res.status, text);
	return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const fetcher = <T>(path: string) => api<T>(path);

export interface EventItem {
	id: number;
	event_name: string;
	distinct_id: string | null;
	user_id: string | null;
	business_user_id: string | null;
	session_id: string | null;
	platform: string | null;
	app_version: string | null;
	client_ts: number | null;
	server_ts: number;
	url: string | null;
	referrer: string | null;
	ua: string | null;
	ip_country: string | null;
	app_id: string;
	app_name: string;
	props: unknown;
}

export interface AppItem {
	app_id: string;
	app_key: string;
	app_secret: string;
	name: string;
	status: "active" | "revoked";
	created_at: number;
	user_id: string;
	user_email: string | null;
	user_name: string | null;
	event_count?: number;
}
