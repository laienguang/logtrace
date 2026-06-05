import { generateAppId, generateKey, invalidateApp, invalidateAppNames } from "../apps";
import { json } from "../respond";
import type { SessionClaims } from "../session";

const APP_COLS = "a.app_id, a.app_key, a.app_secret, a.name, a.status, a.created_at, a.user_id, u.email AS user_email, u.name AS user_name";

export async function handleAppsApi(
	request: Request,
	env: Env,
	url: URL,
	session: SessionClaims,
): Promise<Response> {
	const m = url.pathname.match(/^\/api\/apps(?:\/([^/]+))?$/);
	if (!m) return json({ error: "not found" }, { status: 404 });
	const key = m[1];

	if (!key) {
		if (request.method === "GET") return listApps(env);
		if (request.method === "POST") return createApp(request, env, session);
		return json({ error: "method not allowed" }, { status: 405 });
	}
	if (request.method === "GET") return getApp(env, key);
	if (request.method === "PATCH") return patchApp(request, env, key);
	if (request.method === "DELETE") return deleteApp(env, key);
	return json({ error: "method not allowed" }, { status: 405 });
}

async function listApps(env: Env): Promise<Response> {
	const res = await env.DB.prepare(
		`SELECT ${APP_COLS}
		 FROM apps a
		 LEFT JOIN users u ON u.user_id = a.user_id
		 ORDER BY a.created_at DESC`,
	).all();
	return json({ items: res.results });
}

async function getApp(env: Env, appKey: string): Promise<Response> {
	const row = await env.DB.prepare(
		`SELECT ${APP_COLS}
		 FROM apps a
		 LEFT JOIN users u ON u.user_id = a.user_id
		 WHERE a.app_key = ?`,
	)
		.bind(appKey)
		.first<{ app_id: string }>();
	if (!row) return json({ error: "not found" }, { status: 404 });
	const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE app_id = ?")
		.bind(row.app_id)
		.first<{ n: number }>();
	return json({ ...row, event_count: count?.n ?? 0 });
}

async function createApp(request: Request, env: Env, session: SessionClaims): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return json({ error: "invalid json" }, { status: 400 }); }
	const name = typeof (body as any)?.name === "string" ? (body as any).name.trim() : "";
	if (!name) return json({ error: "name required" }, { status: 400 });
	if (name.length > 64) return json({ error: "name too long" }, { status: 400 });

	const appId = generateAppId();
	const appKey = generateKey("ak");
	const appSecret = generateKey("sk");
	const now = Date.now();
	await env.DB.prepare(
		"INSERT INTO apps (app_id, app_key, app_secret, name, status, created_at, user_id) VALUES (?, ?, ?, ?, 'active', ?, ?)",
	)
		.bind(appId, appKey, appSecret, name, now, session.sub)
		.run();
	invalidateAppNames();
	return json({
		app_id: appId,
		app_key: appKey,
		app_secret: appSecret,
		name,
		status: "active",
		created_at: now,
		user_id: session.sub,
		user_email: session.email ?? null,
		user_name: null,
	}, { status: 201 });
}

async function patchApp(request: Request, env: Env, appKey: string): Promise<Response> {
	let body: any;
	try { body = await request.json(); } catch { return json({ error: "invalid json" }, { status: 400 }); }
	const updates: string[] = [];
	const params: unknown[] = [];
	if (typeof body?.name === "string") {
		const n = body.name.trim();
		if (!n || n.length > 64) return json({ error: "invalid name" }, { status: 400 });
		updates.push("name = ?");
		params.push(n);
	}
	if (body?.status === "active" || body?.status === "revoked") {
		updates.push("status = ?");
		params.push(body.status);
	}
	if (updates.length === 0) return json({ error: "nothing to update" }, { status: 400 });
	params.push(appKey);
	const res = await env.DB.prepare(`UPDATE apps SET ${updates.join(", ")} WHERE app_key = ?`)
		.bind(...params)
		.run();
	invalidateApp(appKey);
	invalidateAppNames();
	if (!res.meta.changes) return json({ error: "not found" }, { status: 404 });
	const row = await env.DB.prepare(
		`SELECT ${APP_COLS}
		 FROM apps a
		 LEFT JOIN users u ON u.user_id = a.user_id
		 WHERE a.app_key = ?`,
	).bind(appKey).first();
	return json(row);
}

async function deleteApp(env: Env, appKey: string): Promise<Response> {
	const row = await env.DB.prepare("SELECT app_id, status FROM apps WHERE app_key = ?")
		.bind(appKey)
		.first<{ app_id: string; status: string }>();
	if (!row) return json({ error: "not found" }, { status: 404 });
	if (row.status !== "revoked") {
		return json({ error: "must revoke first" }, { status: 400 });
	}
	await env.DB.batch([
		env.DB.prepare("DELETE FROM events WHERE app_id = ?").bind(row.app_id),
		env.DB.prepare("DELETE FROM apps WHERE app_key = ?").bind(appKey),
	]);
	invalidateApp(appKey);
	invalidateAppNames();
	return new Response(null, { status: 204 });
}
