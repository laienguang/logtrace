import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "../api";
import { useChart } from "../useChart";

interface Summary {
	from: number;
	to: number;
	pv: number;
	uv: number;
	event_count: number;
}
interface TimeseriesResp {
	metric: string;
	granularity: string;
	from: number;
	to: number;
	bucketMs: number;
	series: { bucket: number; value: number }[];
}

export function Overview({ appId }: { appId: string }) {
	const [granularity, setGranularity] = useState<"hour" | "day">("day");
	const appQS = appId ? `&app_id=${encodeURIComponent(appId)}` : "";

	const { data: summary } = useSWR<Summary>(
		`/api/metrics/summary?${appId ? `app_id=${encodeURIComponent(appId)}` : ""}`,
		fetcher,
		{ refreshInterval: 30_000 },
	);

	const range = granularity === "day" ? 7 * 86400_000 : 24 * 3600_000;
	const to = Math.floor(Date.now() / (granularity === "day" ? 86400_000 : 3600_000)) * (granularity === "day" ? 86400_000 : 3600_000) + (granularity === "day" ? 86400_000 : 3600_000);
	const from = to - range;

	const buildUrl = (metric: string) =>
		`/api/metrics/timeseries?metric=${metric}&granularity=${granularity}&from=${from}&to=${to}${appQS}`;

	const { data: pv } = useSWR<TimeseriesResp>(buildUrl("pv"), fetcher, { refreshInterval: 30_000 });
	const { data: uv } = useSWR<TimeseriesResp>(buildUrl("uv"), fetcher, { refreshInterval: 30_000 });
	const { data: count } = useSWR<TimeseriesResp>(buildUrl("count"), fetcher, { refreshInterval: 30_000 });

	const option = useMemo(() => {
		if (!pv || !uv || !count) return null;
		const buckets = bucketAxis(from, to, granularity === "day" ? 86400_000 : 3600_000);
		const formatLabel = granularity === "day"
			? (ts: number) => new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
			: (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		return {
			tooltip: { trigger: "axis" },
			legend: { data: ["PV", "UV", "事件数"], textStyle: { color: "#e6e8ee" } },
			grid: { left: 40, right: 20, top: 40, bottom: 30 },
			xAxis: {
				type: "category",
				data: buckets.map(formatLabel),
				axisLine: { lineStyle: { color: "#2a2f3d" } },
				axisLabel: { color: "#9aa1ad" },
			},
			yAxis: {
				type: "value",
				axisLine: { lineStyle: { color: "#2a2f3d" } },
				splitLine: { lineStyle: { color: "#20242f" } },
				axisLabel: { color: "#9aa1ad" },
			},
			series: [
				lineSeries("PV", buckets, pv.series, "#4d9fff"),
				lineSeries("UV", buckets, uv.series, "#5fd88c"),
				lineSeries("事件数", buckets, count.series, "#ffa94d"),
			],
		};
	}, [pv, uv, count, from, to, granularity]);

	const ref = useChart(option);

	return (
		<>
			<div className="cards cards-3">
				<Card label="今日 PV" value={summary?.pv} />
				<Card label="今日 UV" value={summary?.uv} />
				<Card label="今日事件数" value={summary?.event_count} />
			</div>
			<div className="panel">
				<div className="controls" style={{ marginBottom: 12 }}>
					<h2 style={{ margin: 0, flex: 1 }}>趋势</h2>
					<select value={granularity} onChange={(e) => setGranularity(e.target.value as any)}>
						<option value="hour">最近 24 小时</option>
						<option value="day">最近 7 天</option>
					</select>
				</div>
				<div className="chart" ref={ref} />
			</div>
		</>
	);
}

function Card({ label, value }: { label: string; value: number | undefined }) {
	return (
		<div className="card">
			<div className="label">{label}</div>
			<div className="value">{value ?? "—"}</div>
		</div>
	);
}

function bucketAxis(from: number, to: number, bucketMs: number): number[] {
	const out: number[] = [];
	for (let t = Math.floor(from / bucketMs) * bucketMs; t < to; t += bucketMs) out.push(t);
	return out;
}

function lineSeries(name: string, buckets: number[], data: { bucket: number; value: number }[], color: string) {
	const map = new Map(data.map((d) => [d.bucket, d.value]));
	return {
		name,
		type: "line" as const,
		smooth: true,
		showSymbol: false,
		areaStyle: { opacity: 0.08 },
		lineStyle: { color, width: 2 },
		itemStyle: { color },
		data: buckets.map((b) => map.get(b) ?? 0),
	};
}
