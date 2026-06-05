import { clearSessionCookie, issueSession, sessionCookie } from "../session";
import { upsertGoogleUser } from "../users";

interface StatePayload {
	state: string;
	next: string;
}

interface GoogleTokenResponse {
	id_token: string;
}

interface GoogleJwtHeader {
	alg?: string;
	kid?: string;
}

interface GoogleJwtClaims {
	aud?: string;
	email?: string;
	email_verified?: boolean | string;
	exp?: number;
	iss?: string;
	name?: string;
	picture?: string;
	sub?: string;
}

interface GoogleJwk {
	alg?: string;
	e: string;
	kid: string;
	kty: string;
	n: string;
	use?: string;
}

interface GoogleJwks {
	keys: GoogleJwk[];
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
let jwksMemoryCache: { data: GoogleJwks; expiresAt: number } | null = null;

export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
	const { pathname } = url;
	if (pathname === "/auth/google" && request.method === "GET") return startOAuth(env, url);
	if (pathname === "/auth/callback" && request.method === "GET") return completeOAuth(request, env, url);
	if (pathname === "/auth/logout" && (request.method === "POST" || request.method === "GET")) return logout(url);
	return new Response("not found", { status: 404 });
}

function isSecure(url: URL): boolean {
	return url.protocol === "https:";
}

function startOAuth(env: Env, url: URL): Response {
	const state = crypto.randomUUID();
	const next = url.searchParams.get("next") || "/";
	const statePayload: StatePayload = { state, next };
	const encodedState = btoa(JSON.stringify(statePayload));

	const redirectUri = `${url.origin}/auth/callback`;
	const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("scope", "openid email profile");
	authUrl.searchParams.set("state", encodedState);
	authUrl.searchParams.set("prompt", "select_account");

	const secure = isSecure(url);
	const stateCookie = oauthStateCookie(state, secure, 300);
	return new Response(null, {
		status: 302,
		headers: {
			location: authUrl.toString(),
			"set-cookie": stateCookie,
		},
	});
}

async function completeOAuth(request: Request, env: Env, url: URL): Promise<Response> {
	const code = url.searchParams.get("code");
	const stateParam = url.searchParams.get("state");
	if (!code || !stateParam) return new Response("missing code/state", { status: 400 });

	let stateObj: StatePayload;
	try {
		stateObj = JSON.parse(atob(stateParam));
	} catch {
		return new Response("bad state", { status: 400 });
	}

	const cookieState = (request.headers.get("cookie") || "").match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
	if (!cookieState || cookieState !== stateObj.state) {
		return new Response("state mismatch", { status: 400 });
	}

	const redirectUri = `${url.origin}/auth/callback`;
	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}),
	});
	if (!tokenRes.ok) {
		const t = await tokenRes.text();
		return new Response(`token exchange failed: ${t}`, { status: 500 });
	}
	const tokenData = await tokenRes.json<GoogleTokenResponse>();
	const claims = await verifyGoogleIdToken(tokenData.id_token, env.GOOGLE_CLIENT_ID);
	const email = claims.email || "";
	const emailVerified = claims.email_verified === true || claims.email_verified === "true";

	const secure = isSecure(url);
	const headers = new Headers();
	headers.append("set-cookie", oauthStateCookie("", secure, 0));

	if (!emailVerified) {
		headers.append("location", `${url.origin}/login?error=email_not_verified`);
		return new Response(null, { status: 302, headers });
	}
	if (!isEmailAllowed(email, env)) {
		const qs = new URLSearchParams({ error: "email_not_allowed", email });
		headers.append("location", `${url.origin}/login?${qs}`);
		return new Response(null, { status: 302, headers });
	}

	const user = await upsertGoogleUser(env, {
		user_id: claims.sub!,
		email,
		name: claims.name,
		avatar_url: claims.picture,
	});
	const token = await issueSession(user.user_id, env.SESSION_SECRET, user.email);
	headers.append("location", safeNext(stateObj.next));
	headers.append("set-cookie", sessionCookie(token, secure));
	return new Response(null, { status: 302, headers });
}

function logout(url: URL): Response {
	const secure = isSecure(url);
	return new Response(null, {
		status: 302,
		headers: {
			location: "/login",
			"set-cookie": clearSessionCookie(secure),
		},
	});
}

function oauthStateCookie(value: string, secure: boolean, maxAge: number): string {
	return `oauth_state=${value}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function isEmailAllowed(email: string, env: Env): boolean {
	const allowed = (env.ALLOWED_EMAILS || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const domain = (env.ALLOWED_EMAIL_DOMAIN || "").trim().toLowerCase();
	if (allowed.length === 0 && !domain) return true;
	const lower = email.toLowerCase();
	if (allowed.includes(lower)) return true;
	if (domain && lower.endsWith(`@${domain}`)) return true;
	return false;
}

function safeNext(next: string): string {
	if (!next.startsWith("/") || next.startsWith("//")) return "/";
	return next;
}

async function verifyGoogleIdToken(idToken: string, audience: string): Promise<GoogleJwtClaims> {
	const parts = idToken.split(".");
	if (parts.length !== 3) throw new Error("invalid id_token");
	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const header = JSON.parse(decodeBase64Url(encodedHeader)) as GoogleJwtHeader;
	const claims = JSON.parse(decodeBase64Url(encodedPayload)) as GoogleJwtClaims;

	if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported signing algorithm");
	if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) throw new Error("invalid issuer");
	if (claims.aud !== audience) throw new Error("invalid audience");
	if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
		throw new Error("expired token");
	}
	if (!claims.sub || !claims.email) throw new Error("missing claims");

	const jwks = await getGoogleJwks();
	const jwk = jwks.keys.find((key) => key.kid === header.kid);
	if (!jwk) throw new Error("signing key not found");

	const key = await crypto.subtle.importKey(
		"jwk",
		jwk as JsonWebKey,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const ok = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		decodeBase64UrlToBytes(encodedSignature),
		new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
	);
	if (!ok) throw new Error("bad signature");
	return claims;
}

async function getGoogleJwks(): Promise<GoogleJwks> {
	const now = Date.now();
	if (jwksMemoryCache && now < jwksMemoryCache.expiresAt) return jwksMemoryCache.data;

	const cache = caches.default;
	const cacheRequest = new Request(GOOGLE_JWKS_URL, { method: "GET" });
	const cached = await cache.match(cacheRequest);
	if (cached) {
		const data = await cached.json<GoogleJwks>();
		const maxAge = getMaxAgeSeconds(cached.headers.get("cache-control"));
		jwksMemoryCache = { data, expiresAt: now + maxAge * 1000 };
		return data;
	}

	const res = await fetch(GOOGLE_JWKS_URL, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error("failed to fetch google jwks");
	const data = await res.clone().json<GoogleJwks>();
	const maxAge = getMaxAgeSeconds(res.headers.get("cache-control"));
	jwksMemoryCache = { data, expiresAt: now + maxAge * 1000 };
	await cache.put(cacheRequest, res.clone());
	return data;
}

function getMaxAgeSeconds(cacheControl: string | null): number {
	const match = cacheControl?.match(/max-age=(\d+)/);
	return match ? Math.max(Number(match[1]), 60) : 3600;
}

function decodeBase64Url(value: string): string {
	return new TextDecoder().decode(decodeBase64UrlToBytes(value));
}

function decodeBase64UrlToBytes(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
