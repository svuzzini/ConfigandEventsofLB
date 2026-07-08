import { useEffect, useState } from 'react';
import type { Inventory } from '@avi/shared';
import { api, type DatasetSummary } from '../api/client.js';
import { BarChart } from './charts/BarChart.js';
import { Treemap } from './charts/Treemap.js';

export function InventoryOverview({ datasetId }: { datasetId: string }) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [summary, setSummary] = useState<DatasetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([api.inventory(datasetId), api.summary(datasetId)])
      .then(([i, s]) => {
        if (alive) {
          setInv(i);
          setSummary(s);
        }
      })
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [datasetId]);

  if (error) return <div className="error">{error}</div>;
  if (!inv || !summary) return <div className="spinner">Loading inventory…</div>;

  const version =
    summary.meta && typeof summary.meta['META'] === 'object'
      ? ((summary.meta['META'] as Record<string, unknown>)['version'] as
          | Record<string, unknown>
          | undefined)
      : undefined;

  return (
    <div>
      <div className="stat-row">
        <Stat k="Objects" v={inv.totalObjects.toLocaleString()} />
        <Stat k="Types" v={String(inv.byType.length)} />
        <Stat k="Tenants" v={String(inv.byTenant.length)} />
        <Stat k="Clouds" v={String(inv.byCloud.length)} />
        <Stat k="Edges" v={summary.edge_count.toLocaleString()} />
        <Stat
          k="Dangling refs"
          v={summary.dangling_count.toLocaleString()}
          sub={summary.dangling_count > 0 ? 'need attention' : 'clean'}
        />
        {version?.['Version'] != null && <Stat k="Version" v={String(version['Version'])} />}
      </div>

      <div className="charts">
        <div className="chart-card wide">
          <h3>Objects by type</h3>
          <Treemap data={inv.byType} />
        </div>
        <div className="chart-card">
          <h3>Objects by tenant</h3>
          <BarChart data={inv.byTenant} />
        </div>
        <div className="chart-card">
          <h3>Objects by cloud</h3>
          <BarChart data={inv.byCloud} />
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">
        {v} {sub && <small>{sub}</small>}
      </div>
    </div>
  );
}
