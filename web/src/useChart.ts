import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
	GridComponent,
	TooltipComponent,
	LegendComponent,
	TitleComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer]);

export function useChart(option: echarts.EChartsCoreOption | null) {
	const ref = useRef<HTMLDivElement | null>(null);
	const instRef = useRef<echarts.ECharts | null>(null);

	useEffect(() => {
		if (!ref.current) return;
		const inst = echarts.init(ref.current, "dark");
		instRef.current = inst;
		const onResize = () => inst.resize();
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			inst.dispose();
			instRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!instRef.current) return;
		if (option) instRef.current.setOption(option, true);
		else instRef.current.clear();
	}, [option]);

	return ref;
}
