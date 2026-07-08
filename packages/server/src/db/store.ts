/**
 * Storage abstraction.
 *
 * Full object payloads are persisted here so neither the Node heap nor the
 * browser ever holds the whole dump. Two implementations satisfy this contract:
 *
 *   - SqliteStore  (default) — Node's built-in `node:sqlite`. Zero native build,
 *     ships with the runtime, ideal for the "minimal-dependency / single deploy"
 *     goal. Handles dumps into the low hundreds of MB comfortably.
 *   - DuckdbStore  (opt-in, STORE=duckdb) — columnar engine for very large
 *     deployments where inventory rollups over millions of rows dominate.
 *
 * Both share identical SQL semantics (json_extract, LIKE, GROUP BY), so the API
 * layer is storage-agnostic.
 */
import type { InventoryBucket } from '@avi/shared';

export interface StoredRow {
  readonly datasetId: string;
  readonly uuid: string;
  readonly type: string;
  readonly name: string | null;
  readonly tenant: string | null;
  readonly cloud: string | null;
  readonly raw: string; // JSON text
}

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

export interface ListObjectsArgs {
  readonly datasetId: string;
  readonly type: string;
  readonly search: string | null;
  readonly sort: string;
  readonly dir: 'asc' | 'desc';
  readonly offset: number;
  readonly limit: number;
}

export interface Inventory {
  readonly total: number;
  readonly byType: InventoryBucket[];
  readonly byTenant: InventoryBucket[];
  readonly byCloud: InventoryBucket[];
}

export interface Store {
  insertObjects(rows: readonly StoredRow[]): Promise<void>;
  insertMeta(datasetId: string, entries: readonly (readonly [string, unknown])[]): Promise<void>;
  recordDataset(rec: DatasetRecord): Promise<void>;
  getDataset(datasetId: string): Promise<DatasetRecord | null>;
  listDatasets(): Promise<DatasetRecord[]>;
  getMeta(datasetId: string): Promise<Record<string, unknown> | null>;
  inventory(datasetId: string): Promise<Inventory>;
  listObjects(args: ListObjectsArgs): Promise<{ total: number; rows: StoredRow[] }>;
  getRaw(datasetId: string, uuid: string): Promise<StoredRow | null>;
  getRawMany(datasetId: string, uuids: readonly string[]): Promise<Map<string, string>>;
  forEachObject(datasetId: string, fn: (type: string, raw: string) => void): Promise<void>;
  close(): Promise<void>;
}

/** Columns that may be sorted directly; anything else is treated as a JSON path. */
export const FIXED_SORT_COLUMNS = new Set(['name', 'uuid', 'tenant', 'cloud', 'type']);

/** Open the configured store. STORE=duckdb selects the columnar backend. */
export async function openStore(path: string): Promise<Store> {
  const kind = (process.env['STORE'] ?? 'sqlite').toLowerCase();
  if (kind === 'duckdb') {
    const { DuckdbStore } = await import('./duckdb-store.js');
    return DuckdbStore.open(path);
  }
  const { SqliteStore } = await import('./sqlite-store.js');
  return SqliteStore.open(path);
}
