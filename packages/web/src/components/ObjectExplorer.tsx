import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Inventory, ObjectDetail, ObjectListPage, SortDir } from '@avi/shared';
import { api } from '../api/client.js';
import { JsonView } from './JsonView.js';

const PAGE = 50;

export function ObjectExplorer({ datasetId }: { datasetId: string }) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [dir, setDir] = useState<SortDir>('asc');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ObjectListPage | null>(null);
  const [openUuid, setOpenUuid] = useState<string | null>(null);
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.inventory(datasetId).then((i) => {
      setInv(i);
      setType((t) => t ?? i.byType[0]?.key ?? null);
    }).catch((e: unknown) => setError(String(e)));
  }, [datasetId]);

  const load = useCallback(() => {
    if (!type) return;
    setError(null);
    api
      .objects(datasetId, type, { search, sort, dir, offset, limit: PAGE })
      .then(setPage)
      .catch((e: unknown) => setError(String(e)));
  }, [datasetId, type, search, sort, dir, offset]);

  useEffect(() => {
    const id = setTimeout(load, 150); // debounce search
    return () => clearTimeout(id);
  }, [load]);

  const onSort = (col: string) => {
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(col);
      setDir('asc');
    }
    setOffset(0);
  };

  const toggleRow = (uuid: string) => {
    if (openUuid === uuid) {
      setOpenUuid(null);
      setDetail(null);
      return;
    }
    setOpenUuid(uuid);
    setDetail(null);
    api.object(datasetId, uuid).then(setDetail).catch((e: unknown) => setError(String(e)));
  };

  const columns = page?.columns ?? [];
  const totalPages = page ? Math.max(1, Math.ceil(page.total / PAGE)) : 1;
  const curPage = Math.floor(offset / PAGE) + 1;

  const typeList = useMemo(() => inv?.byType ?? [], [inv]);

  return (
    <div className="rel-layout">
      <div className="card rel-list">
        <div className="k" style={{ marginBottom: 8 }}>Object types</div>
        {typeList.map((t) => (
          <div
            key={t.key}
            className={`item${type === t.key ? ' sel' : ''}`}
            onClick={() => {
              setType(t.key);
              setOffset(0);
              setOpenUuid(null);
              setDetail(null);
            }}
          >
            <span className="mono">{t.key}</span>
            <span style={{ float: 'right' }} className="muted">{t.count}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="toolbar">
          <input
            type="search"
            placeholder="filter by name or uuid…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
          <span className="muted">{page ? `${page.total.toLocaleString()} objects` : ''}</span>
        </div>
        {error && <div className="error">{error}</div>}
        <div style={{ overflow: 'auto', maxHeight: '64vh' }}>
          <table>
            <thead>
              <tr>
                <Th col="name" label="Name" sort={sort} dir={dir} onSort={onSort} />
                <Th col="uuid" label="UUID" sort={sort} dir={dir} onSort={onSort} />
                <Th col="tenant" label="Tenant" sort={sort} dir={dir} onSort={onSort} />
                <Th col="cloud" label="Cloud" sort={sort} dir={dir} onSort={onSort} />
                {columns.map((c) => (
                  <Th key={c} col={c} label={c} sort={sort} dir={dir} onSort={onSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {page?.rows.map((r) => (
                <RowGroup
                  key={r.uuid}
                  open={openUuid === r.uuid}
                  detail={openUuid === r.uuid ? detail : null}
                  colCount={4 + columns.length}
                  onClick={() => toggleRow(r.uuid)}
                  cells={
                    <>
                      <td className="name">{r.name ?? '—'}</td>
                      <td className="mono" title={r.uuid}>{r.uuid}</td>
                      <td className="mono">{r.tenant ?? '—'}</td>
                      <td className="mono">{r.cloud ?? '—'}</td>
                      {columns.map((c) => (
                        <td key={c} className="mono">{renderCell(r.cells[c])}</td>
                      ))}
                    </>
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ‹ Prev
          </button>
          <span>Page {curPage} / {totalPages}</span>
          <button
            className="btn"
            disabled={!page || offset + PAGE >= page.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next ›
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({
  col, label, sort, dir, onSort,
}: { col: string; label: string; sort: string; dir: SortDir; onSort: (c: string) => void }) {
  return (
    <th onClick={() => onSort(col)}>
      {label} {sort === col ? (dir === 'asc' ? '▲' : '▼') : ''}
    </th>
  );
}

function RowGroup({
  cells, open, detail, colCount, onClick,
}: {
  cells: React.ReactNode; open: boolean; detail: ObjectDetail | null; colCount: number; onClick: () => void;
}) {
  return (
    <>
      <tr className="clickable" onClick={onClick}>{cells}</tr>
      {open && (
        <tr>
          <td colSpan={colCount} style={{ background: '#0b0f18' }}>
            {detail ? <DetailPanel detail={detail} /> : <div className="spinner">Loading…</div>}
          </td>
        </tr>
      )}
    </>
  );
}

function DetailPanel({ detail }: { detail: ObjectDetail }) {
  return (
    <div style={{ padding: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div className="k" style={{ marginBottom: 6 }}>Outgoing references ({detail.outgoing.length})</div>
          {detail.outgoing.map((e, i) => (
            <div key={i} style={{ marginBottom: 3 }}>
              <span className="edge-field">{e.field}</span>{' → '}
              {e.to ? (
                <span className="mono">{e.refName ?? e.to}</span>
              ) : (
                <span className="resolved-name">⚠ {e.refName ?? 'unresolved'} (dangling)</span>
              )}
            </div>
          ))}
          <div className="k" style={{ margin: '10px 0 6px' }}>Referenced by ({detail.incoming.length})</div>
          {detail.incoming.map((e, i) => (
            <div key={i} className="mono" style={{ marginBottom: 3 }}>
              {e.from} <span className="edge-field">({e.field})</span>
            </div>
          ))}
        </div>
        <JsonView value={detail.raw} />
      </div>
    </div>
  );
}

function renderCell(v: string | null | undefined): React.ReactNode {
  if (v == null) return <span className="muted">—</span>;
  if (v === 'true') return <span className="bool-t">true</span>;
  if (v === 'false') return <span className="bool-f">false</span>;
  return v;
}
