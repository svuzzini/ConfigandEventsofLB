import ReactECharts from 'echarts-for-react';
import type { InventoryBucket } from '@avi/shared';

/** Treemap of object counts by type — area encodes relative volume at a glance. */
export function Treemap({ data }: { data: readonly InventoryBucket[] }) {
  const option = {
    tooltip: { formatter: (p: { name: string; value: number }) => `${p.name}: ${p.value}` },
    series: [
      {
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        data: data.map((d) => ({ name: d.key, value: d.count })),
        itemStyle: { borderColor: '#0f1420', borderWidth: 2, gapWidth: 2 },
        levels: [
          {
            color: ['#6366f1', '#818cf8', '#a5b4fc', '#4f46e5', '#7c3aed', '#8b5cf6'],
            colorMappingBy: 'index',
          },
        ],
        label: { color: '#fff', fontSize: 11, formatter: '{b}\n{c}' },
      },
    ],
  };
  return <ReactECharts option={option} style={{ height: 300 }} />;
}
