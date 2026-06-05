import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "./api";
import { Login } from "./Login";
import { Overview } from "./tabs/Overview";
import { Realtime } from "./tabs/Realtime";
import { Detail } from "./tabs/Detail";
import { Apps } from "./tabs/Apps";

type TabKey = "overview" | "realtime" | "detail" | "apps";

const TABS: { key: TabKey; label: string }[] = [
	{ key: "overview", label: "概览" },
	{ key: "realtime", label: "实时" },
	{ key: "detail", label: "明细" },
	{ key: "apps", label: "应用管理" },
];

export default function App() {
	if (window.location.pathname === "/login") return <Login />;
	return <Dashboard />;
}

function Dashboard() {
	const [tab, setTab] = useState<TabKey>(() => {
		const fromHash = window.location.hash.replace("#", "");
		return (TABS.find((t) => t.key === fromHash)?.key as TabKey) || "overview";
	});
	const [appId, setAppId] = useState<string>("");

	useEffect(() => {
		window.location.hash = tab;
	}, [tab]);

	const { data: me } = useSWR<{ user_id: string; email: string | null; name: string | null }>("/api/me", fetcher);
	const { data: appsData } = useSWR<{ items: { app_id: string; name: string; status: string }[] }>("/api/apps", fetcher);
	const activeApps = (appsData?.items || []).filter((a) => a.status === "active");

	return (
		<div className="app">
			<header className="topbar">
				<h1>logtrace</h1>
				<select value={appId} onChange={(e) => setAppId(e.target.value)}>
					<option value="">全部应用</option>
					{activeApps.map((a) => (
						<option key={a.app_id} value={a.app_id}>{a.name}</option>
					))}
				</select>
				<div className="grow" />
				<span className="user">{me?.name || me?.email || ""}</span>
				<button onClick={() => (window.location.href = "/auth/logout")}>退出</button>
			</header>
			<nav className="tabs">
				{TABS.map((t) => (
					<button
						key={t.key}
						className={tab === t.key ? "active" : ""}
						onClick={() => setTab(t.key)}
					>
						{t.label}
					</button>
				))}
			</nav>
			<main className="content">
				{tab === "overview" && <Overview appId={appId} />}
				{tab === "realtime" && <Realtime appId={appId} />}
				{tab === "detail" && <Detail appId={appId} />}
				{tab === "apps" && <Apps />}
			</main>
		</div>
	);
}
