/**
 * Modular ECharts setup + a minimal typed React wrapper.
 *
 * We register ONLY the pieces this app uses (bar, treemap, graph + canvas
 * renderer). Importing the full `echarts` package via echarts-for-react pulled
 * every chart type into the bundle (~1.2 MB minified); the modular build cuts
 * the chart payload by more than half, and React.lazy in App.tsx keeps even
 * that out of the initial page load.
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, TreemapChart, GraphChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';

echarts.use([
  BarChart,
  TreemapChart,
  GraphChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

/** Shared dark tooltip styling so charts match the app theme. */
export const DARK_TOOLTIP = {
  backgroundColor: '#1e2536',
  borderColor: '#2a3346',
  textStyle: { color: '#e6ebf5', fontSize: 12 },
} as const;

export interface EChartProps {
  readonly option: EChartsCoreOption;
  readonly style?: React.CSSProperties;
  /** Replace the whole option instead of merging (default true). */
  readonly notMerge?: boolean;
}

export function EChart({ option, style, notMerge = true }: EChartProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  // Init once; auto-resize with the container; dispose on unmount.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge });
  }, [option, notMerge]);

  return <div ref={elRef} style={style} />;
}
