import type { InventoryBucket } from '@avi/shared';
import { EChart, DARK_TOOLTIP } from './echarts.js';

/** Horizontal bar chart for a set of inventory buckets. */
export function BarChart({ data, max = 15 }: { data: readonly InventoryBucket[]; max?: number }) {
  const top = data.slice(0, max);
  const categories = top.map((d) => d.key).reverse();
  const values = top.map((d) => d.count).reverse();
  const option = {
    grid: { left: 4, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...DARK_TOOLTIP },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a3346' } }, axisLabel: { color: '#6b7688' } },
    yAxis: {
      type: 'category', data: categories,
      axisLabel: { color: '#aab4c8', fontSize: 11 },
      axisLine: { lineStyle: { color: '#2a3346' } },
    },
    series: [
      {
        type: 'bar', data: values, barMaxWidth: 18,
        itemStyle: { color: '#6366f1', borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: '#aab4c8', fontSize: 11 },
      },
    ],
  };
  return <EChart option={option} style={{ height: Math.max(120, top.length * 26) }} />;
}
