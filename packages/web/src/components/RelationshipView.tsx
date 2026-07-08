import { useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { DependencyGraph, ObjectListPage } from '@avi/shared';
import { api } from '../api/client.js';

/**
 * Relationship view: choose a VirtualService and see its full resolved
 * dependency chain (VS → vsvip → pool(group) → health monitors → SE group →
 * certs/profiles). Rendered as an ECharts force graph; nodes are coloured by
 * object type and sized by depth.
 */
export function RelationshipView({ datasetId }: { datasetId: string }) {
  const [vsPage, setVsPage] = useState<ObjectListPage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [graph, setGraph] = useState<DependencyGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .objects(datasetId, 'VirtualService', { sort: 'name', limit: 500 })
      .then((p) => {
        setVsPage(p);
        setSelected((s) => s ?? p.rows[0]?.uuid ?? null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [datasetId]);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    api.graph(datasetId, selected, 12).then(setGraph).catch((e: unknown) => setError(String(e)));
  }, [datasetId, selected]);

  const option = useMemo(() => (graph ? buildOption(graph) : null), [graph]);

  return (
    <div className="rel-layout">
      <div className="card rel-list">
        <div className="k" style={{ marginBottom: 8 }}>Virtual services</div>
        {vsPage?.rows.length === 0 && <div className="muted">No VirtualService objects.</div>}
        {vsPage?.rows.map((r) => (
          <div
            key={r.uuid}
            className={`item${selected === r.uuid ? ' sel' : ''}`}
            onClick={() => setSelected(r.uuid)}
          >
            <div style={{ fontWeight: 600 }}>{r.name ?? r.uuid}</div>
            <div className="muted mono" style={{ fontSize: 10 }}>{r.tenant ?? ''}</div>
          </div>
        ))}
      </div>

      <div className="card">
        {error && <div className="error">{error}</div>}
        {graph && (
          <div className="muted" style={{ marginBottom: 6 }}>
            {graph.nodes.length} objects · {graph.edges.length} references
            {graph.truncated && ' · (truncated)'}
          </div>
        )}
        {option ? (
          <ReactECharts option={option} style={{ height: '70vh' }} notMerge />
        ) : (
          <div className="spinner">Select a virtual service…</div>
        )}
      </div>
    </div>
  );
}

const TYPE_COLORS: Record<string, string> = {
  VirtualService: '#6366f1', VsVip: '#22d3ee', Pool: '#34d399', PoolGroup: '#10b981',
  HealthMonitor: '#f59e0b', ServiceEngineGroup: '#a78bfa', SSLKeyAndCertificate: '#f87171',
  ApplicationProfile: '#fbbf24', NetworkProfile: '#fb923c', Tenant: '#94a3b8', Cloud: '#64748b',
};

function buildOption(graph: DependencyGraph) {
  const types = Array.from(new Set(graph.nodes.map((n) => n.type)));
  const categories = types.map((t) => ({ name: t, itemStyle: { color: TYPE_COLORS[t] ?? '#818cf8' } }));
  const catIndex = new Map(types.map((t, i) => [t, i]));
  const present = new Set(graph.nodes.map((n) => n.uuid));

  const nodes = graph.nodes.map((n) => ({
    id: n.uuid,
    name: `${n.name ?? n.uuid}\n(${n.type})`,
    category: catIndex.get(n.type) ?? 0,
    symbolSize: Math.max(12, 40 - n.depth * 7),
    value: n.depth,
  }));
  const links = graph.edges
    .filter((e) => e.to !== null && present.has(e.to))
    .map((e) => ({ source: e.from, target: e.to as string, label: { show: false }, value: e.field }));

  return {
    tooltip: { formatter: (p: { data: { value?: unknown } }) => String(p.data.value ?? '') },
    legend: [{ data: types, textStyle: { color: '#aab4c8' }, top: 0 }],
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        categories,
        data: nodes,
        links,
        force: { repulsion: 220, edgeLength: 90, gravity: 0.08 },
        label: { show: true, color: '#e6ebf5', fontSize: 10, position: 'right' },
        lineStyle: { color: '#3b4358', opacity: 0.5, curveness: 0.1, width: 1.2 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 2.5 } },
      },
    ],
  };
}
