import { useEffect, useMemo, useRef, useState } from 'react';
import type { DependencyGraph, ObjectListPage } from '@avi/shared';
import { api } from '../api/client.js';
import { EChart, DARK_TOOLTIP } from './charts/echarts.js';

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
  // Monotonic sequence: a slow response for a previously-selected VS must not
  // overwrite the graph of the currently-selected one.
  const seqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    api
      .objects(datasetId, 'VirtualService', { sort: 'name', limit: 500 })
      .then((p) => {
        if (!alive) return;
        setVsPage(p);
        setSelected((s) => s ?? p.rows[0]?.uuid ?? null);
      })
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [datasetId]);

  useEffect(() => {
    if (!selected) return;
    const seq = ++seqRef.current;
    setError(null);
    api
      .graph(datasetId, selected, 12)
      .then((g) => {
        if (seq === seqRef.current) setGraph(g);
      })
      .catch((e: unknown) => {
        if (seq === seqRef.current) setError(String(e));
      });
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
          <EChart option={option} style={{ height: '70vh' }} />
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

interface NodeDatum {
  readonly id: string;
  readonly name: string;
  readonly category: number;
  readonly symbolSize: number;
  /** [type, displayName, depth] for the tooltip. */
  readonly value: readonly [string, string, number];
}
interface LinkDatum {
  readonly source: string;
  readonly target: string;
  /** Ref field name for the tooltip. */
  readonly value: string;
}
interface TooltipParams {
  readonly dataType: 'node' | 'edge';
  readonly data: NodeDatum | LinkDatum;
}

function buildOption(graph: DependencyGraph) {
  const types = Array.from(new Set(graph.nodes.map((n) => n.type)));
  const categories = types.map((t) => ({ name: t, itemStyle: { color: TYPE_COLORS[t] ?? '#818cf8' } }));
  const catIndex = new Map(types.map((t, i) => [t, i]));
  const present = new Set(graph.nodes.map((n) => n.uuid));

  const nodes: NodeDatum[] = graph.nodes.map((n) => ({
    id: n.uuid,
    name: n.name ?? n.uuid,
    category: catIndex.get(n.type) ?? 0,
    symbolSize: Math.max(12, 40 - n.depth * 7),
    value: [n.type, n.name ?? n.uuid, n.depth] as const,
  }));
  const links: LinkDatum[] = graph.edges
    .filter((e) => e.to !== null && present.has(e.to))
    .map((e) => ({ source: e.from, target: e.to as string, value: e.field }));

  return {
    tooltip: {
      ...DARK_TOOLTIP,
      formatter: (p: TooltipParams) => {
        if (p.dataType === 'edge') {
          const d = p.data as LinkDatum;
          return `<b>${d.value}</b>`;
        }
        const d = p.data as NodeDatum;
        return `<b>${d.value[1]}</b><br/>${d.value[0]} · depth ${d.value[2]}`;
      },
    },
    legend: [{ data: types, textStyle: { color: '#aab4c8' }, top: 0 }],
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        zoom: 1.3,
        categories,
        data: nodes,
        links,
        force: { repulsion: 320, edgeLength: 120, gravity: 0.06 },
        label: { show: true, color: '#e6ebf5', fontSize: 10, position: 'right' },
        lineStyle: { color: '#3b4358', opacity: 0.5, curveness: 0.1, width: 1.2 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 2.5 } },
      },
    ],
  };
}
