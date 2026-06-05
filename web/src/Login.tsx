import { useEffect, useState } from "react";

const ERROR_MESSAGES: Record<string, (params: URLSearchParams) => string> = {
	email_not_allowed: (p) => `账号 ${p.get("email") || ""} 不在白名单内`,
	email_not_verified: () => "Google 账号邮箱未验证",
};

export function Login() {
	const params = new URLSearchParams(window.location.search);
	const next = params.get("next") || "/";
	const errorCode = params.get("error");
	const errorMsg = errorCode && ERROR_MESSAGES[errorCode] ? ERROR_MESSAGES[errorCode](params) : errorCode;
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		document.title = "登录 · logtrace";
	}, []);

	const onSignIn = () => {
		setBusy(true);
		window.location.href = `/auth/google?next=${encodeURIComponent(next)}`;
	};

	return (
		<div className="login-page">
			<div className="login-card">
				<div className="brand">
					<div className="logo">L</div>
					<div className="brand-text">
						<div className="brand-name">logtrace</div>
						<div className="brand-sub">埋点数据看板</div>
					</div>
				</div>
				{errorMsg && <div className="error-box" role="alert">{errorMsg}</div>}
				<button className="google-btn" disabled={busy} onClick={onSignIn}>
					<GoogleG />
					<span>{busy ? "跳转中…" : "使用 Google 登录"}</span>
				</button>
				<div className="login-hint">使用 Google 账号登录</div>
			</div>
		</div>
	);
}

function GoogleG() {
	return (
		<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
			<path
				fill="#4285F4"
				d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
			/>
			<path
				fill="#34A853"
				d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
			/>
			<path
				fill="#FBBC05"
				d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
			/>
			<path
				fill="#EA4335"
				d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
			/>
		</svg>
	);
}
