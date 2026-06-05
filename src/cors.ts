export function corsHeaders(): Record<string, string> {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-headers": "content-type, x-app-key, x-app-secret",
		"access-control-max-age": "86400",
	};
}

export function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
