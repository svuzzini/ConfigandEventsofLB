import { lazy, Suspense, useEffect, useState } from 'react';
import type { IngestResult } from '@avi/shared';
import { api, type DatasetRecord } from './api/client.js';
import { UploadPanel } from './components/UploadPanel.js';

// Each tab is code-split so the initial page load ships only the app shell;
// ECharts (the heaviest dependency) loads the first time a chart tab renders.
const InventoryOverview = lazy(() =>
  import('./components/InventoryOverview.js').then((m) => ({ default: m.InventoryOverview })),
);
const ObjectExplorer = lazy(() =>
  import('./components/ObjectExplorer.js').then((m) => ({ default: m.ObjectExplorer })),
);
const RelationshipView = lazy(() =>
  import('./components/RelationshipView.js').then((m) => ({ default: m.RelationshipView })),
);
const HygienePanel = lazy(() =>
  import('./components/HygienePanel.js').then((m) => ({ default: m.HygienePanel })),
);

type Tab = 'overview' | 'explorer' | 'relationships' | 'hygiene';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Inventory' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'hygiene', label: 'Hygiene' },
];

export function App() {
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    api.listDatasets().then((d) => {
      setDatasets(d);
      setDatasetId((cur) => cur ?? d[0]?.dataset_id ?? null);
    }).catch(() => undefined);
  }, []);

  const onIngested = (r: IngestResult) => {
    setDatasetId(r.datasetId);
    setTab('overview');
    setShowUpload(false);
    api.listDatasets().then(setDatasets).catch(() => undefined);
  };

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>Avi Config Analyzer</h1>
          <div className="sub">NSX ALB configuration graph & hygiene</div>
        </div>
        {datasets.length > 0 && (
          <select
            value={datasetId ?? ''}
            onChange={(e) => setDatasetId(e.target.value || null)}
          >
            {datasets.map((d) => (
              <option key={d.dataset_id} value={d.dataset_id}>
                {d.file_name} · {d.object_count.toLocaleString()} objs
              </option>
            ))}
          </select>
        )}
        {datasetId && (
          <button className="btn" onClick={() => setShowUpload((v) => !v)}>
            {showUpload ? 'Close' : '+ New dataset'}
          </button>
        )}
        {datasetId && (
          <div className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="body">
        {!datasetId ? (
          <UploadPanel onIngested={onIngested} />
        ) : (
          <>
            {showUpload && (
              <div style={{ marginBottom: 14 }}>
                <UploadPanel onIngested={onIngested} />
              </div>
            )}
            <Suspense fallback={<div className="spinner">Loading view…</div>}>
              {tab === 'overview' && <InventoryOverview datasetId={datasetId} />}
              {tab === 'explorer' && <ObjectExplorer datasetId={datasetId} />}
              {tab === 'relationships' && <RelationshipView datasetId={datasetId} />}
              {tab === 'hygiene' && <HygienePanel datasetId={datasetId} />}
            </Suspense>
          </>
        )}
      </div>
    </div>
  );
}
