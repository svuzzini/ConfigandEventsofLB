/**
 * Typed API client. Every method returns a shared DTO — no `any`, no `unknown`
 * leaking to callers. The browser only ever receives paginated / aggregated
 * responses, never the raw dump.
 */
import type {
  DependencyGraph,
  HygieneReport,
  IngestResult,
  Inventory,
  ObjectDetail,
  ObjectListPage,
  SortDir,
} from '@avi/shared';

export interface DatasetRecord {
  readonly dataset_id: string;
  readonly file_name: string;
  readonly bytes: number;
  readonly object_count: number;
  readonly type_count: number;
  readonly edge_count: number;
  readonly dangling_count: number;
  readonly created_at: string;
}
export interface DatasetSummary extends DatasetRecord {
  readonly meta: Record<string, unknown> | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GET ${url} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  async ingest(file: File, onProgress?: (loaded: number) => void): Promise<IngestResult> {
    // File is streamed as the request body; the browser never parses it.
    void onProgress;
    const res = await fetch(`/api/datasets?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ingest failed (${res.status}): ${detail}`);
    }
    return (await res.json()) as IngestResult;
  },

  listDatasets: (): Promise<DatasetRecord[]> => getJson('/api/datasets'),
  summary: (id: string): Promise<DatasetSummary> => getJson(`/api/datasets/${id}/summary`),
  inventory: (id: string): Promise<Inventory> => getJson(`/api/datasets/${id}/inventory`),

  objects: (
    id: string,
    type: string,
    opts: { search?: string; sort?: string; dir?: SortDir; offset?: number; limit?: number } = {},
  ): Promise<ObjectListPage> => {
    const q = new URLSearchParams();
    if (opts.search) q.set('search', opts.search);
    if (opts.sort) q.set('sort', opts.sort);
    if (opts.dir) q.set('dir', opts.dir);
    if (opts.offset != null) q.set('offset', String(opts.offset));
    if (opts.limit != null) q.set('limit', String(opts.limit));
    return getJson(`/api/datasets/${id}/types/${encodeURIComponent(type)}/objects?${q.toString()}`);
  },

  object: (id: string, uuid: string): Promise<ObjectDetail> =>
    getJson(`/api/datasets/${id}/objects/${encodeURIComponent(uuid)}`),
  graph: (id: string, uuid: string, depth = 12): Promise<DependencyGraph> =>
    getJson(`/api/datasets/${id}/objects/${encodeURIComponent(uuid)}/graph?depth=${depth}`),
  hygiene: (id: string): Promise<HygieneReport> => getJson(`/api/datasets/${id}/hygiene`),
};
