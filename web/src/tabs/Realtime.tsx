import { useEffect, useRef, useState } from "react";
import { api, type EventItem } from "../api";

export function Realtime({ appId }: { appId: string }) {
	const [items, setItems] = useState<EventItem[]>([]);
	const [eventFilter, setEventFilter] = useState("");
	const [paused, setPaused] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sinceRef = useRef<number>(Date.now() - 5 * 60_000);

	useEffect(() => {
		sinceRef.current = Date.now() - 5 * 60_000;
		setItems([]);
	}, [appId, eventFilter]);

	useEffect(() => {
		if (paused) return;
		let cancelled = false;
		const tick = async () => {
			try {
				const qs = new URLSearchParams({ since: String(sinceRef.current), limit: "100" });
				if (appId) qs.set("app_id", appId);
				if (eventFilter) qs.set("event", eventFilter);
				const data = await api<{ items: EventItem[]; lastTs: number }>(`/api/events/stream?${qs}`);
				if (cancelled) return;
				if (data.items.length > 0) {
					sinceRef.current = data.lastTs;
					setItems((prev) => [...data.items, ...prev].slice(0, 200));
				}
				setError(null);
			} catch (e: any) {
				if (!cancelled) setError(String(e?.message || e));
			}
		};
		tick();
		const id = setInterval(tick, 3000);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [paused, appId, eventFilter]);

	return (
		<div className="panel">
			<div className="controls" style={{ marginBottom: 12 }}>
				<h2 style={{ margin: 0, flex: 1 }}>实时事件流</h2>
				<input
					placeholder="按事件名过滤"
					value={eventFilter}
					onChange={(e) => setEventFilter(e.target.value)}
					style={{ width: 200 }}
				/>
				<button className="ghost" onClick={() => setPaused((p) => !p)}>
					{paused ? "继续" : "暂停"}
				</button>
				<button className="ghost" onClick={() => setItems([])}>清空</button>
				<span className="muted">{paused ? "已暂停" : `每 3s 刷新 · 已 ${items.length}/200 条`}</span>
			</div>
			{error && <div className="error-box">{error}</div>}
			{items.length === 0 ? (
				<div className="empty">等待事件…</div>
			) : (
				<table className="tbl">
					<thead>
						<tr>
							<th style={{ width: 160 }}>时间</th>
							<th style={{ width: 100 }}>app</th>
							<th>event</th>
							<th>distinct_id</th>
							<th>url</th>
							<th>props</th>
						</tr>
					</thead>
					<tbody>
						{items.map((e) => (
							<tr key={e.id}>
								<td className="muted">{new Date(e.server_ts).toLocaleTimeString("zh-CN", { hour12: false })}.{String(e.server_ts % 1000).padStart(3, "0")}</td>
								<td><span className="tag" title={e.app_id}>{e.app_name}</span></td>
								<td>{e.event_name}</td>
								<td className="muted">{e.distinct_id || "—"}</td>
								<td className="muted">{e.url || "—"}</td>
								<td><pre>{e.props ? JSON.stringify(e.props) : ""}</pre></td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
