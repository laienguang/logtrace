export interface AppRecord {
	app_id: string;
	app_key: string;
	app_secret: string;
	name: string;
	status: string;
	created_at: number;
	user_id: string;
}

const cache = new Map<string, { rec: AppRecord | null; ts: number }>();
const TTL_MS = 60_000;

const APP_COLS = "app_id, app_key, app_secret, name, status, created_at, user_id";

export async function lookupApp(env: Env, appKey: string): Promise<AppRecord | null> {
	const now = Date.now();
	const hit = cache.get(appKey);
	if (hit && now - hit.ts < TTL_MS) return hit.rec;
	const row = await env.DB.prepare(`SELECT ${APP_COLS} FROM apps WHERE app_key = ?`)
		.bind(appKey)
		.first<AppRecord>();
	cache.set(appKey, { rec: row ?? null, ts: now });
	return row ?? null;
}

export function invalidateApp(appKey: string) {
	cache.delete(appKey);
}

// app_id -> name map cache, used by query handlers to inject app_name in responses.
let namesCache: { map: Map<string, string>; ts: number } | null = null;
const NAMES_TTL_MS = 30_000;

export async function loadAppNames(env: Env): Promise<Map<string, string>> {
	const now = Date.now();
	if (namesCache && now - namesCache.ts < NAMES_TTL_MS) return namesCache.map;
	const res = await env.DB.prepare("SELECT app_id, name FROM apps").all<{ app_id: string; name: string }>();
	const map = new Map<string, string>();
	for (const r of res.results) map.set(r.app_id, r.name);
	namesCache = { map, ts: now };
	return map;
}

export function invalidateAppNames() {
	namesCache = null;
}

export async function verifyAppCredentials(
	env: Env,
	appKey: string,
	appSecret: string,
): Promise<AppRecord | null> {
	const app = await lookupApp(env, appKey);
	if (!app) return null;
	if (app.status !== "active") return null;
	if (!timingSafeEqual(app.app_secret, appSecret)) return null;
	return app;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export function generateKey(prefix: "ak" | "sk"): string {
	return randomId(prefix, 24);
}

export function generateAppId(): string {
	return randomId("app", 8);
}

function randomId(prefix: string, byteLen: number): string {
	const bytes = new Uint8Array(byteLen);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
	return `${prefix}_${hex}`;
}
