import { loadAppNames } from "../apps";
import { json } from "../respond";

interface EventRow {
	id: number;
	event_name: string;
	distinct_id: string | null;
	user_id: string | null;
	session_id: string | null;
	client_ts: number | null;
	server_ts: number;
	url: string | null;
	referrer: string | null;
	ua: string | null;
	ip_country: string | null;
	app_id: string;
	props: string | null;
}

export async function handleEventsApi(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== "GET") return json({ error: "method not allowed" }, { status: 405 });
	if (url.pathname === "/api/events/stream") return stream(env, url);
	if (url.pathname === "/api/events/names") return names(env);
	if (url.pathname === "/api/events") return list(env, url);
	return json({ error: "not found" }, { status: 404 });
}

const SELECT_COLS =
	"id, event_name, distinct_id, user_id, session_id, client_ts, server_ts, url, referrer, ua, ip_country, app_id, props";

async function hydrate(rows: EventRow[], env: Env) {
	const names = await loadAppNames(env);
	return rows.map((r) => ({
		...r,
		props: r.props ? safeParse(r.props) : null,
		app_name: names.get(r.app_id) ?? r.app_id,
	}));
}

function safeParse(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

async function list(env: Env, url: URL): Promise<Response> {
	const sp = url.searchParams;
	const limit = Math.min(Math.max(Number(sp.get("limit") || 50), 1), 200);
	const where: string[] = [];
	const params: unknown[] = [];

	const eventName = sp.get("event");
	const did = sp.get("distinct_id");
	const uid = sp.get("user_id");
	const appId = sp.get("app_id");
	const from = sp.get("from");
	const to = sp.get("to");
	if (eventName) { where.push("event_name = ?"); params.push(eventName); }
	if (did) { where.push("distinct_id = ?"); params.push(did); }
	if (uid) { where.push("user_id = ?"); params.push(uid); }
	if (appId) { where.push("app_id = ?"); params.push(appId); }
	if (from) { where.push("server_ts >= ?"); params.push(Number(from)); }
	if (to) { where.push("server_ts < ?"); params.push(Number(to)); }

	const cursor = sp.get("cursor");
	if (cursor) {
		const [tsStr, idStr] = cursor.split(":");
		const ts = Number(tsStr);
		const id = Number(idStr);
		if (Number.isFinite(ts) && Number.isFinite(id)) {
			where.push("(server_ts < ? OR (server_ts = ? AND id < ?))");
			params.push(ts, ts, id);
		}
	}

	const sql = `SELECT ${SELECT_COLS} FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY server_ts DESC, id DESC LIMIT ?`;
	const res = await env.DB.prepare(sql).bind(...params, limit + 1).all<EventRow>();
	const rows = res.results.slice(0, limit);
	let nextCursor: string | null = null;
	if (res.results.length > limit) {
		const last = rows[rows.length - 1];
		nextCursor = `${last.server_ts}:${last.id}`;
	}
	return json({ items: await hydrate(rows, env), nextCursor });
}

async function stream(env: Env, url: URL): Promise<Response> {
	const sp = url.searchParams;
	const since = Number(sp.get("since") || Date.now() - 5 * 60_000);
	const limit = Math.min(Math.max(Number(sp.get("limit") || 100), 1), 500);
	const eventName = sp.get("event");
	const appId = sp.get("app_id");
	const where: string[] = ["server_ts > ?"];
	const params: unknown[] = [since];
	if (eventName) { where.push("event_name = ?"); params.push(eventName); }
	if (appId) { where.push("app_id = ?"); params.push(appId); }
	const sql = `SELECT ${SELECT_COLS} FROM events WHERE ${where.join(" AND ")} ORDER BY server_ts DESC, id DESC LIMIT ?`;
	const res = await env.DB.prepare(sql).bind(...params, limit).all<EventRow>();
	const items = await hydrate(res.results, env);
	const lastTs = items.length ? items[0].server_ts : since;
	return json({ items, lastTs });
}

async function names(env: Env): Promise<Response> {
	const since = Date.now() - 7 * 86400_000;
	const res = await env.DB.prepare(
		"SELECT DISTINCT event_name FROM events WHERE server_ts > ? ORDER BY event_name LIMIT 200",
	)
		.bind(since)
		.all<{ event_name: string }>();
	return json({ names: res.results.map((r) => r.event_name) });
}
