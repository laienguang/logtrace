import { verifyAppCredentials } from "../apps";
import { corsHeaders } from "../cors";

interface InboundEvent {
	event_name?: unknown;
	distinct_id?: unknown;
	session_id?: unknown;
	client_ts?: unknown;
	url?: unknown;
	referrer?: unknown;
	props?: unknown;
}

const MAX_BATCH = 50;
const MAX_EVENT_NAME = 64;
const MAX_PROPS_BYTES = 4096;
const MAX_URL = 2048;

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

	type Row = [string, string | null, string | null, string | null, number | null, number, string | null, string | null, string | null, string | null, string, string | null];
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
		];
		rows.push(row);
	}

	const stmt = env.DB.prepare(
		"INSERT INTO events (event_name, distinct_id, user_id, session_id, client_ts, server_ts, url, referrer, ua, ip_country, app_id, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	if (rows.length === 1) {
		await stmt.bind(...rows[0]).run();
	} else {
		await env.DB.batch(rows.map((r) => stmt.bind(...r)));
	}

	return new Response(null, { status: 204, headers: corsHeaders() });
}

function str(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t ? t.slice(0, 256) : null;
}

function truncStr(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	return v.slice(0, max);
}
