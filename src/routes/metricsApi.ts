import { json } from "../respond";

export async function handleMetricsApi(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== "GET") return json({ error: "method not allowed" }, { status: 405 });
	if (url.pathname === "/api/metrics/timeseries") return timeseries(env, url);
	if (url.pathname === "/api/metrics/summary") return summary(env, url);
	return json({ error: "not found" }, { status: 404 });
}

async function timeseries(env: Env, url: URL): Promise<Response> {
	const sp = url.searchParams;
	const metric = (sp.get("metric") || "pv").toLowerCase();
	const granularity = sp.get("granularity") === "day" ? "day" : "hour";
	const eventName = sp.get("event");
	const appId = sp.get("app_id");
	const now = Date.now();
	const defaultRange = granularity === "day" ? 7 * 86400_000 : 24 * 3600_000;
	const from = Number(sp.get("from") || now - defaultRange);
	const to = Number(sp.get("to") || now);
	const bucketMs = granularity === "day" ? 86400_000 : 3600_000;

	let agg: string;
	if (metric === "uv") agg = "COUNT(DISTINCT distinct_id)";
	else if (metric === "users") agg = "COUNT(DISTINCT CASE WHEN user_id IS NOT NULL AND user_id != '' THEN user_id END)";
	else agg = "COUNT(*)";

	const where: string[] = ["server_ts >= ?", "server_ts < ?"];
	const params: unknown[] = [from, to];
	if (eventName) { where.push("event_name = ?"); params.push(eventName); }
	if (appId) { where.push("app_id = ?"); params.push(appId); }

	const sql = `SELECT (server_ts / ${bucketMs}) * ${bucketMs} AS bucket, ${agg} AS value FROM events WHERE ${where.join(" AND ")} GROUP BY bucket ORDER BY bucket ASC`;
	const res = await env.DB.prepare(sql).bind(...params).all<{ bucket: number; value: number }>();
	return json({ metric, granularity, from, to, bucketMs, series: res.results });
}

async function summary(env: Env, url: URL): Promise<Response> {
	const sp = url.searchParams;
	const appId = sp.get("app_id");
	const now = Date.now();
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const from = todayStart.getTime();

	const where: string[] = ["server_ts >= ?", "server_ts < ?"];
	const params: unknown[] = [from, now];
	if (appId) { where.push("app_id = ?"); params.push(appId); }
	const whereSql = "WHERE " + where.join(" AND ");

	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS pv,
		        COUNT(DISTINCT distinct_id) AS uv,
		        COUNT(DISTINCT CASE WHEN user_id IS NOT NULL AND user_id != '' THEN user_id END) AS users,
		        COUNT(*) AS event_count
		 FROM events ${whereSql}`,
	)
		.bind(...params)
		.first<{ pv: number; uv: number; users: number; event_count: number }>();
	return json({ from, to: now, ...row });
}
