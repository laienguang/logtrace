function b64urlEncode(input: ArrayBuffer | Uint8Array | string): string {
	const bytes = typeof input === "string"
		? new TextEncoder().encode(input)
		: input instanceof Uint8Array ? input : new Uint8Array(input);
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Uint8Array {
	s = s.replace(/-/g, "+").replace(/_/g, "/");
	while (s.length % 4) s += "=";
	return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
	const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64urlEncode(JSON.stringify(payload));
	const data = `${header}.${body}`;
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
	return `${data}.${b64urlEncode(sig)}`;
}

export async function verifyJWT<T = Record<string, unknown>>(token: string, secret: string): Promise<T> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("invalid token");
	const [h, p, s] = parts;
	const ok = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret),
		b64urlDecode(s),
		new TextEncoder().encode(`${h}.${p}`),
	);
	if (!ok) throw new Error("bad signature");
	const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
	if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
		throw new Error("expired");
	}
	return payload as T;
}
