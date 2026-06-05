import { signJWT, verifyJWT } from "./jwt";

export interface SessionClaims {
	sub: string; // user_id
	email?: string;
	iat: number;
	exp: number;
}

const SESSION_TTL_SEC = 86400; // 24h

export async function issueSession(userId: string, secret: string, email?: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJWT({ sub: userId, email, iat: now, exp: now + SESSION_TTL_SEC }, secret);
}

export function readSessionCookie(request: Request): string | null {
	const cookie = request.headers.get("cookie") || "";
	const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
	return m ? m[1] : null;
}

export async function verifySession(request: Request, secret: string): Promise<SessionClaims | null> {
	const token = readSessionCookie(request);
	if (!token) return null;
	try {
		return await verifyJWT<SessionClaims>(token, secret);
	} catch {
		return null;
	}
}

export function sessionCookie(token: string, secure: boolean, maxAge = SESSION_TTL_SEC): string {
	const flags = ["HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
	if (secure) flags.push("Secure");
	return `session=${token}; ${flags.join("; ")}`;
}

export function clearSessionCookie(secure: boolean): string {
	const flags = ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
	if (secure) flags.push("Secure");
	return `session=; ${flags.join("; ")}`;
}
