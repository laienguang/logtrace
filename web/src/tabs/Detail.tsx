import { Fragment, useEffect, useState } from "react";
import useSWR from "swr";
import { api, fetcher, type EventItem } from "../api";

interface Filters {
	event: string;
	distinct_id: string;
	business_user_id: string;
	platform: string;
	from: string;
	to: string;
}

const defaultFilters: Filters = {
	event: "",
	distinct_id: "",
	business_user_id: "",
	platform: "",
	from: "",
	to: "",
};

export function Detail({ appId }: { appId: string }) {
	const [filters, setFilters] = useState<Filters>(defaultFilters);
	const [applied, setApplied] = useState<Filters>(defaultFilters);
	const [pages, setPages] = useState<EventItem[][]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<number>>(new Set());

	const { data: namesData } = useSWR<{ names: string[] }>("/api/events/names", fetcher);

	const buildQS = (cur: string | null) => {
		const qs = new URLSearchParams({ limit: "50" });
		if (appId) qs.set("app_id", appId);
		if (applied.event) qs.set("event", applied.event);
		if (applied.distinct_id) qs.set("distinct_id", applied.distinct_id);
		if (applied.business_user_id) qs.set("business_user_id", applied.business_user_id);
		if (applied.platform) qs.set("platform", applied.platform);
		if (applied.from) qs.set("from", String(new Date(applied.from).getTime()));
		if (applied.to) qs.set("to", String(new Date(applied.to).getTime()));
		if (cur) qs.set("cursor", cur);
		return qs.toString();
	};

	const loadPage = async (cur: string | null) => {
		setLoading(true);
		setError(null);
		try {
			const data = await api<{ items: EventItem[]; nextCursor: string | null }>(`/api/events?${buildQS(cur)}`);
			if (cur === null) setPages([data.items]);
			else setPages((p) => [...p, data.items]);
			setCursor(data.nextCursor);
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadPage(null);
	}, [applied, appId]);

	const apply = () => setApplied(filters);
	const reset = () => {
		setFilters(defaultFilters);
		setApplied(defaultFilters);
	};

	const items = pages.flat();
	const toggle = (id: number) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id); else next.add(id);
			return next;
		});
	};

	return (
		<div className="panel">
			<div className="controls" style={{ marginBottom: 12 }}>
				<select value={filters.event} onChange={(e) => setFilters({ ...filters, event: e.target.value })}>
					<option value="">全部事件</option>
					{namesData?.names.map((n) => <option key={n} value={n}>{n}</option>)}
				</select>
				<input placeholder="distinct_id"
					value={filters.distinct_id}
					onChange={(e) => setFilters({ ...filters, distinct_id: e.target.value })}
				/>
				<input placeholder="business_user_id"
					value={filters.business_user_id}
					onChange={(e) => setFilters({ ...filters, business_user_id: e.target.value })}
				/>
				<input list="platform-suggest" placeholder="platform"
					value={filters.platform}
					onChange={(e) => setFilters({ ...filters, platform: e.target.value })}
					style={{ width: 120 }}
				/>
				<datalist id="platform-suggest">
					<option value="web" />
					<option value="ios" />
					<option value="android" />
					<option value="backend" />
				</datalist>
				<input type="datetime-local" value={filters.from}
					onChange={(e) => setFilters({ ...filters, from: e.target.value })}
				/>
				<input type="datetime-local" value={filters.to}
					onChange={(e) => setFilters({ ...filters, to: e.target.value })}
				/>
				<button onClick={apply}>应用</button>
				<button className="ghost" onClick={reset}>重置</button>
			</div>
			{error && <div className="error-box">{error}</div>}
			{items.length === 0 && !loading ? (
				<div className="empty">无数据</div>
			) : (
				<>
					<table className="tbl">
						<thead>
							<tr>
								<th style={{ width: 160 }}>时间</th>
								<th style={{ width: 90 }}>app</th>
								<th>event</th>
								<th>distinct_id</th>
								<th>url</th>
								<th style={{ width: 50 }}></th>
							</tr>
						</thead>
						<tbody>
							{items.map((e) => (
								<Fragment key={e.id}>
									<tr key={e.id} onClick={() => toggle(e.id)} style={{ cursor: "pointer" }}>
										<td className="muted">{new Date(e.server_ts).toLocaleString("zh-CN", { hour12: false })}</td>
										<td><span className="tag" title={e.app_id}>{e.app_name}</span></td>
										<td>{e.event_name}</td>
										<td className="muted">{e.distinct_id || "—"}</td>
										<td className="muted" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.url || "—"}</td>
										<td className="muted">{expanded.has(e.id) ? "▾" : "▸"}</td>
									</tr>
									{expanded.has(e.id) && (
										<tr key={`${e.id}-detail`}>
											<td colSpan={6} style={{ background: "var(--surface-2)" }}>
												<pre>{JSON.stringify({
													session_id: e.session_id,
													client_ts: e.client_ts,
													referrer: e.referrer,
													ua: e.ua,
													ip_country: e.ip_country,
													user_id: e.user_id,
													business_user_id: e.business_user_id,
													platform: e.platform,
													app_version: e.app_version,
													props: e.props,
												}, null, 2)}</pre>
											</td>
										</tr>
									)}
								</Fragment>
							))}
						</tbody>
					</table>
					<div style={{ marginTop: 12, textAlign: "center" }}>
						{cursor ? (
							<button className="ghost" disabled={loading} onClick={() => loadPage(cursor)}>
								{loading ? "加载中…" : "加载更多"}
							</button>
						) : (
							<span className="muted">已到底部</span>
						)}
					</div>
				</>
			)}
		</div>
	);
}
