import { useEffect, useState } from 'react';
import type { HygieneReport, HygieneSeverity } from '@avi/shared';
import { api } from '../api/client.js';

const SEVERITIES: HygieneSeverity[] = ['critical', 'warning', 'info'];

export function HygienePanel({ datasetId }: { datasetId: string }) {
  const [report, setReport] = useState<HygieneReport | null>(null);
  const [filter, setFilter] = useState<HygieneSeverity | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    setReport(null);
    api
      .hygiene(datasetId)
      .then((r) => alive && setReport(r))
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [datasetId]);

  if (error) return <div className="error">{error}</div>;
  if (!report) return <div className="spinner">Running hygiene checks…</div>;

  const shown = report.findings.filter((f) => filter === 'all' || f.severity === filter);

  return (
    <div>
      <div className="stat-row">
        {SEVERITIES.map((s) => (
          <div
            key={s}
            className="stat"
            style={{ cursor: 'pointer', outline: filter === s ? '1px solid var(--accent)' : 'none' }}
            onClick={() => setFilter(filter === s ? 'all' : s)}
          >
            <div className="k">{s}</div>
            <div className="v">{report.countsBySeverity[s]}</div>
          </div>
        ))}
        <div className="stat" style={{ cursor: 'pointer' }} onClick={() => setFilter('all')}>
          <div className="k">total</div>
          <div className="v">{report.findings.length}</div>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Rule</th>
              <th>Object</th>
              <th>Type</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f, i) => (
              <tr key={i}>
                <td><span className={`sev ${f.severity}`}>{f.severity}</span></td>
                <td className="mono">{f.ruleId}</td>
                <td className="name">{f.subject.name ?? f.subject.uuid}</td>
                <td className="mono">{f.subject.type}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 520 }}>{f.detail}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ padding: 20 }}>No findings. 🎉</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
