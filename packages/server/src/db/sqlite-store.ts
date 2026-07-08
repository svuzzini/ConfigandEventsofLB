/**
 * Default store backed by Node's built-in `node:sqlite` (no native build).
 * SQLite's bundled JSON1 gives us json_extract for schema-free scalar projection
 * and sort, matching the DuckDB implementation's semantics.
 */
import { DatabaseSync } from 'node:sqlite';
import type { InventoryBucket } from '@avi/shared';
import {
  FIXED_SORT_COLUMNS,
  type DatasetRecord,
  type Inventory,
  type ListObjectsArgs,
  type Store,
  type StoredRow,
} from './store.js';

const BATCH_LIMIT = 500; // SQLite default max compound-insert / variable budget

export class SqliteStore implements Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): SqliteStore {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    const store = new SqliteStore(db);
    store.init();
    return store;
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        dataset_id TEXT, uuid TEXT, type TEXT,
        name TEXT, tenant TEXT, cloud TEXT, raw TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (dataset_id TEXT, key TEXT, value TEXT);
      CREATE TABLE IF NOT EXISTS datasets (
        dataset_id TEXT PRIMARY KEY, file_name TEXT, bytes INTEGER,
        object_count INTEGER, type_count INTEGER, edge_count INTEGER,
        dangling_count INTEGER, created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_obj_ds_type ON objects(dataset_id, type);
      CREATE INDEX IF NOT EXISTS idx_obj_ds_uuid ON objects(dataset_id, uuid);
    `);
  }

  async insertObjects(rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO objects (dataset_id, uuid, type, name, tenant, cloud, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        stmt.run(r.datasetId, r.uuid, r.type, r.name, r.tenant, r.cloud, r.raw);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async insertMeta(
    datasetId: string,
    entries: readonly (readonly [string, unknown])[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(`INSERT INTO meta (dataset_id, key, value) VALUES (?, ?, ?)`);
    for (const [k, v] of entries) {
      stmt.run(datasetId, k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }

  async recordDataset(rec: DatasetRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO datasets
         (dataset_id, file_name, bytes, object_count, type_count, edge_count, dangling_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.dataset_id, rec.file_name, rec.bytes, rec.object_count,
        rec.type_count, rec.edge_count, rec.dangling_count, rec.created_at,
      );
  }

  async getDataset(datasetId: string): Promise<DatasetRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM datasets WHERE dataset_id = ?`)
      .get(datasetId) as Record<string, unknown> | undefined;
    return row ? toDatasetRecord(row) : null;
  }

  async listDatasets(): Promise<DatasetRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM datasets ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(toDatasetRecord);
  }

  async getMeta(datasetId: string): Promise<Record<string, unknown> | null> {
    const rows = this.db
      .prepare(`SELECT key, value FROM meta WHERE dataset_id = ?`)
      .all(datasetId) as { key: string; value: string }[];
    if (rows.length === 0) return null;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  }

  async inventory(datasetId: string): Promise<Inventory> {
    const group = (col: string): InventoryBucket[] => {
      const rows = this.db
        .prepare(
          `SELECT COALESCE(${col}, '(none)') AS key, COUNT(*) AS count
           FROM objects WHERE dataset_id = ? GROUP BY 1 ORDER BY count DESC, key ASC`,
        )
        .all(datasetId) as { key: string; count: number }[];
      return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
    };
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM objects WHERE dataset_id = ?`)
      .get(datasetId) as { c: number };
    return {
      total: Number(totalRow.c),
      byType: group('type'),
      byTenant: group('tenant'),
      byCloud: group('cloud'),
    };
  }

  async listObjects(args: ListObjectsArgs): Promise<{ total: number; rows: StoredRow[] }> {
    const { datasetId, type, search, sort, dir, offset, limit } = args;
    const where = ['dataset_id = ?', 'type = ?'];
    const whereParams: (string | number)[] = [datasetId, type];
    if (search) {
      where.push('(name LIKE ? OR uuid LIKE ?)');
      whereParams.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.join(' AND ');

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM objects WHERE ${whereSql}`)
      .get(...whereParams) as { c: number };

    const dirSql = dir === 'desc' ? 'DESC' : 'ASC';
    let orderExpr: string;
    const orderParams: string[] = [];
    if (FIXED_SORT_COLUMNS.has(sort)) {
      orderExpr = sort;
    } else {
      orderExpr = 'json_extract(raw, ?)';
      orderParams.push('$.' + sort);
    }

    const rows = this.db
      .prepare(
        `SELECT dataset_id, uuid, type, name, tenant, cloud, raw
         FROM objects WHERE ${whereSql}
         ORDER BY ${orderExpr} ${dirSql}, name ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...whereParams, ...orderParams, limit, offset) as Record<string, unknown>[];

    return { total: Number(totalRow.c), rows: rows.map(toStoredRow) };
  }

  async getRaw(datasetId: string, uuid: string): Promise<StoredRow | null> {
    const row = this.db
      .prepare(
        `SELECT dataset_id, uuid, type, name, tenant, cloud, raw
         FROM objects WHERE dataset_id = ? AND uuid = ? LIMIT 1`,
      )
      .get(datasetId, uuid) as Record<string, unknown> | undefined;
    return row ? toStoredRow(row) : null;
  }

  async getRawMany(datasetId: string, uuids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < uuids.length; i += BATCH_LIMIT) {
      const chunk = uuids.slice(i, i + BATCH_LIMIT);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT uuid, raw FROM objects WHERE dataset_id = ? AND uuid IN (${placeholders})`,
        )
        .all(datasetId, ...chunk) as { uuid: string; raw: string }[];
      for (const r of rows) out.set(r.uuid, r.raw);
    }
    return out;
  }

  async forEachObject(datasetId: string, fn: (type: string, raw: string) => void): Promise<void> {
    // node:sqlite has no incremental cursor API yet; page through by rowid to
    // avoid materializing every row object at once.
    const page = 5000;
    let lastRowId = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT rowid AS rid, type, raw FROM objects
           WHERE dataset_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(datasetId, lastRowId, page) as { rid: number; type: string; raw: string }[];
      if (rows.length === 0) break;
      for (const r of rows) {
        fn(r.type, r.raw);
        lastRowId = r.rid;
      }
      if (rows.length < page) break;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function toDatasetRecord(r: Record<string, unknown>): DatasetRecord {
  return {
    dataset_id: String(r['dataset_id']),
    file_name: String(r['file_name']),
    bytes: Number(r['bytes']),
    object_count: Number(r['object_count']),
    type_count: Number(r['type_count']),
    edge_count: Number(r['edge_count']),
    dangling_count: Number(r['dangling_count']),
    created_at: String(r['created_at']),
  };
}

function toStoredRow(r: Record<string, unknown>): StoredRow {
  return {
    datasetId: String(r['dataset_id']),
    uuid: String(r['uuid']),
    type: String(r['type']),
    name: r['name'] == null ? null : String(r['name']),
    tenant: r['tenant'] == null ? null : String(r['tenant']),
    cloud: r['cloud'] == null ? null : String(r['cloud']),
    raw: String(r['raw']),
  };
}
