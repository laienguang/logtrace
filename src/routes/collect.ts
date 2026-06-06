import { verifyAppCredentials } from "../apps";
import { corsHeaders } from "../cors";

interface InboundEvent {
	event_name?: unknown;
	event_id?: unknown;
	distinct_id?: unknown;
	business_user_id?: unknown;
	session_id?: unknown;
	platform?: unknown;
	app_version?: unknown;
	client_ts?: unknown;
	url?: unknown;
	referrer?: unknown;
	props?: unknown;
}

const MAX_BATCH = 50;
const MAX_EVENT_NAME = 64;
const MAX_EVENT_ID = 64;
const MAX_PROPS_BYTES = 16384;       // 16KB; large enough to hold panic stacks / long prompts
const MAX_URL = 2048;
const MAX_BUSINESS_USER_ID = 64;
const MAX_PLATFORM = 64;
const MAX_APP_VERSION = 32;

function jsonCors(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...corsHeaders() },
	});
}

export async function handleCollect(request: Request, env: Env): Promise<Response> {
	const appKey = request.headers.get("x-app-key");
	const appSecret = request.headers.get("x-app-secret");
	if (!appKey || !appSecret) return jsonCors({ error: "missing credentials" }, 403);
	const app = await verifyAppCredentials(env, appKey, appSecret);
	if (!app) return jsonCors({ error: "invalid credentials" }, 403);

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return jsonCors({ error: "invalid json" }, 400);
	}

	const inbound: InboundEvent[] = (() => {
		if (payload && typeof payload === "object" && Array.isArray((payload as any).events)) {
			return (payload as any).events as InboundEvent[];
		}
		if (payload && typeof payload === "object" && typeof (payload as any).event_name === "string") {
			return [payload as InboundEvent];
		}
		return [];
	})();

	if (inbound.length === 0) return jsonCors({ error: "no events" }, 400);
	if (inbound.length > MAX_BATCH) return jsonCors({ error: "batch too large" }, 400);

	const now = Date.now();
	const ua = request.headers.get("user-agent");
	const country = (request as any).cf?.country ?? null;

	type Row = [
		string,         // event_name
		string | null,  // distinct_id
		string | null,  // user_id (server-filled from app.user_id)
		string | null,  // session_id
		number | null,  // client_ts
		number,         // server_ts
		string | null,  // url
		string | null,  // referrer
		string | null,  // ua
		string | null,  // ip_country
		string,         // app_id
		string | null,  // props (JSON string)
		string | null,  // business_user_id
		string | null,  // platform
		string | null,  // app_version
		string | null,  // event_id (idempotency key; UNIQUE on (app_id, event_id) where not null)
	];
	const rows: Row[] = [];
	for (const e of inbound) {
		if (typeof e?.event_name !== "string" || !e.event_name) {
			return jsonCors({ error: "event_name required" }, 400);
		}
		const eventName = e.event_name;
		if (eventName.length > MAX_EVENT_NAME) {
			return jsonCors({ error: "event_name too long" }, 400);
		}
		let propsStr: string | null = null;
		if (e.props !== undefined && e.props !== null) {
			try {
				propsStr = JSON.stringify(e.props);
			} catch {
				return jsonCors({ error: "invalid props" }, 400);
			}
			if (propsStr.length > MAX_PROPS_BYTES) {
				return jsonCors({ error: "props too large" }, 400);
			}
		}
		// events.user_id is the Google login user id associated with this app.
		// It is resolved from apps.user_id via x-app-key/x-app-secret auth,
		// NOT taken from the caller's body to prevent spoofing.
		const userId = app.user_id;

		const row: Row = [
			eventName,
			str(e.distinct_id),
			userId,
			str(e.session_id),
			typeof e.client_ts === "number" ? e.client_ts : null,
			now,
			truncStr(e.url, MAX_URL),
			truncStr(e.referrer, MAX_URL),
			ua,
			country,
			app.app_id,
			propsStr,
			str(e.business_user_id, MAX_BUSINESS_USER_ID),
			str(e.platform, MAX_PLATFORM),
			str(e.app_version, MAX_APP_VERSION),
			str(e.event_id, MAX_EVENT_ID),
		];
		rows.push(row);
	}

	// INSERT OR IGNORE: rows with event_id that collide with existing (app_id, event_id)
	// are silently skipped (idempotent dedup). Rows without event_id are unaffected because
	// the UNIQUE index has WHERE event_id IS NOT NULL.
	const stmt = env.DB.prepare(
		"INSERT OR IGNORE INTO events (event_name, distinct_id, user_id, session_id, client_ts, server_ts, url, referrer, ua, ip_country, app_id, props, business_user_id, platform, app_version, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	if (rows.length === 1) {
		await stmt.bind(...rows[0]).run();
	} else {
		await env.DB.batch(rows.map((r) => stmt.bind(...r)));
	}

	return new Response(null, { status: 204, headers: corsHeaders() });
}

function str(v: unknown, max: number = 256): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t ? t.slice(0, max) : null;
}

function truncStr(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	return v.slice(0, max);
}
