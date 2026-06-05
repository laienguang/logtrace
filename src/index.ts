import { corsHeaders } from "./cors";
import { json } from "./respond";
import { handleAuth } from "./routes/auth";
import { handleCollect } from "./routes/collect";
import { handleEventsApi } from "./routes/eventsApi";
import { handleMetricsApi } from "./routes/metricsApi";
import { handleAppsApi } from "./routes/appsApi";
import { verifySession } from "./session";
import { getUserById } from "./users";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		if (pathname === "/collect") {
			if (request.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}
			if (request.method === "POST") return handleCollect(request, env);
			return new Response("method not allowed", { status: 405 });
		}

		if (pathname.startsWith("/auth/")) return handleAuth(request, env, url);

		if (pathname.startsWith("/api/")) {
			const session = await verifySession(request, env.SESSION_SECRET);
			if (!session) return json({ error: "unauthorized" }, { status: 401 });
			if (pathname === "/api/me") {
				const user = await getUserById(env, session.sub);
				return json({
					user_id: session.sub,
					email: user?.email ?? session.email ?? null,
					name: user?.name ?? null,
					avatar_url: user?.avatar_url ?? null,
				});
			}
			if (pathname.startsWith("/api/events")) return handleEventsApi(request, env, url);
			if (pathname.startsWith("/api/metrics")) return handleMetricsApi(request, env, url);
			if (pathname.startsWith("/api/apps")) return handleAppsApi(request, env, url, session);
			return json({ error: "not found" }, { status: 404 });
		}

		// HTML / static
		const accept = request.headers.get("accept") || "";
		const wantsHtml = request.method === "GET" && accept.includes("text/html");
		if (wantsHtml && pathname !== "/login") {
			const session = await verifySession(request, env.SESSION_SECRET);
			if (!session) {
				const next = encodeURIComponent(pathname + url.search);
				return Response.redirect(`${url.origin}/login?next=${next}`, 302);
			}
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
