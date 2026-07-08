/**
 * Opt-in columnar store (STORE=duckdb). Same contract as SqliteStore but backed
 * by DuckDB, whose columnar GROUP BY is well suited to inventory rollups over
 * millions of rows. Requires the optional `duckdb-async` dependency; it is
 * imported lazily so the server runs without it when the SQLite store is used.
 */
import type { InventoryBucket } from '@avi/shared';
import {
  FIXED_SORT_COLUMNS,
  type DatasetRecord,
  type Inventory,
  type ListObjectsArgs,
  type Store,
  type StoredRow,
} from './store.js';
import { log } from '../util/logger.js';

// Structural type for the bits of duckdb-async we use — avoids a hard type dep.
interface DuckDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: unknown[]): Promise<unknown>;
  all(sql: string, ...params: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

export class DuckdbStore implements Store {
  private constructor(private readonly db: DuckDatabase) {}

  static async open(path: string): Promise<DuckdbStore> {
    const mod = (await import('duckdb-async')) as unknown as {
      Database: { create(p: string): Promise<DuckDatabase> };
    };
    const db = await mod.Database.create(path);
    const store = new DuckdbStore(db);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    try {
      await this.db.exec('INSTALL json; LOAD json;');
    } catch (err) {
      log.debug('json extension load skipped', { err: String(err) });
    }
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        dataset_id VARCHAR, uuid VARCHAR, type VARCHAR,
        name VARCHAR, tenant VARCHAR, cloud VARCHAR, raw VARCHAR
      );
      CREATE TABLE IF NOT EXISTS meta (dataset_id VARCHAR, key VARCHAR, value VARCHAR);
      CREATE TABLE IF NOT EXISTS datasets (
        dataset_id VARCHAR PRIMARY KEY, file_name VARCHAR, bytes BIGINT,
        object_count BIGINT, type_count BIGINT, edge_count BIGINT,
        dangling_count BIGINT, created_at VARCHAR
      );
      CREATE INDEX IF NOT EXISTS idx_obj_ds_type ON objects(dataset_id, type);
      CREATE INDEX IF NOT EXISTS idx_obj_ds_uuid ON objects(dataset_id, uuid);
      CREATE INDEX IF NOT EXISTS idx_obj_ds_type_name ON objects(dataset_id, type, name);
    `);
  }

  async insertObjects(rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params: (string | null)[] = [];
    for (const r of rows) params.push(r.datasetId, r.uuid, r.type, r.name, r.tenant, r.cloud, r.raw);
    await this.db.run(`INSERT INTO objects VALUES ${placeholders}`, ...params);
  }

  async insertMeta(
    datasetId: string,
    entries: readonly (readonly [string, unknown])[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const placeholders = entries.map(() => '(?,?,?)').join(',');
    const params: (string | null)[] = [];
    for (const [k, v] of entries) {
      params.push(datasetId, k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    await this.db.run(`INSERT INTO meta VALUES ${placeholders}`, ...params);
  }

  async recordDataset(rec: DatasetRecord): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO datasets VALUES (?,?,?,?,?,?,?,?)`,
      rec.dataset_id, rec.file_name, rec.bytes, rec.object_count,
      rec.type_count, rec.edge_count, rec.dangling_count, rec.created_at,
    );
  }

  async getDataset(datasetId: string): Promise<DatasetRecord | null> {
    const rows = (await this.db.all(
      `SELECT * FROM datasets WHERE dataset_id = ?`, datasetId,
    )) as Record<string, unknown>[];
    return rows[0] ? toDatasetRecord(rows[0]) : null;
  }

  async listDatasets(): Promise<DatasetRecord[]> {
    const rows = (await this.db.all(
      `SELECT * FROM datasets ORDER BY created_at DESC`,
    )) as Record<string, unknown>[];
    return rows.map(toDatasetRecord);
  }

  async getMeta(datasetId: string): Promise<Record<string, unknown> | null> {
    const rows = (await this.db.all(
      `SELECT key, value FROM meta WHERE dataset_id = ?`, datasetId,
    )) as { key: string; value: string }[];
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
    const group = async (col: string): Promise<InventoryBucket[]> => {
      const rows = (await this.db.all(
        `SELECT COALESCE(${col}, '(none)') AS key, COUNT(*)::BIGINT AS count
         FROM objects WHERE dataset_id = ? GROUP BY 1 ORDER BY count DESC, key ASC`,
        datasetId,
      )) as { key: string; count: number | bigint }[];
      return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
    };
    const totalRows = (await this.db.all(
      `SELECT COUNT(*)::BIGINT AS c FROM objects WHERE dataset_id = ?`, datasetId,
    )) as { c: number | bigint }[];
    const [byType, byTenant, byCloud] = await Promise.all([
      group('type'), group('tenant'), group('cloud'),
    ]);
    return { total: Number(totalRows[0]?.c ?? 0), byType, byTenant, byCloud };
  }

  async listObjects(args: ListObjectsArgs): Promise<{ total: number; rows: StoredRow[] }> {
    const { datasetId, type, search, sort, dir, offset, limit } = args;
    const where = ['dataset_id = ?', 'type = ?'];
    const whereParams: (string | number)[] = [datasetId, type];
    if (search) {
      where.push('(name ILIKE ? OR uuid ILIKE ?)');
      whereParams.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.join(' AND ');
    const countRows = (await this.db.all(
      `SELECT COUNT(*)::BIGINT AS c FROM objects WHERE ${whereSql}`, ...whereParams,
    )) as { c: number | bigint }[];

    const dirSql = dir === 'desc' ? 'DESC' : 'ASC';
    let orderExpr: string;
    const orderParams: string[] = [];
    if (FIXED_SORT_COLUMNS.has(sort)) {
      orderExpr = sort;
    } else {
      orderExpr = 'json_extract_string(raw, ?)';
      orderParams.push('$.' + sort);
    }

    const rows = (await this.db.all(
      `SELECT dataset_id, uuid, type, name, tenant, cloud, raw
       FROM objects WHERE ${whereSql}
       ORDER BY ${orderExpr} ${dirSql} NULLS LAST, name ASC
       LIMIT ? OFFSET ?`,
      ...whereParams, ...orderParams, limit, offset,
    )) as Record<string, unknown>[];

    return { total: Number(countRows[0]?.c ?? 0), rows: rows.map(toStoredRow) };
  }

  async getRaw(datasetId: string, uuid: string): Promise<StoredRow | null> {
    const rows = (await this.db.all(
      `SELECT dataset_id, uuid, type, name, tenant, cloud, raw
       FROM objects WHERE dataset_id = ? AND uuid = ? LIMIT 1`,
      datasetId, uuid,
    )) as Record<string, unknown>[];
    return rows[0] ? toStoredRow(rows[0]) : null;
  }

  async getRawMany(datasetId: string, uuids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (uuids.length === 0) return out;
    const placeholders = uuids.map(() => '?').join(',');
    const rows = (await this.db.all(
      `SELECT uuid, raw FROM objects WHERE dataset_id = ? AND uuid IN (${placeholders})`,
      datasetId, ...uuids,
    )) as { uuid: string; raw: string }[];
    for (const r of rows) out.set(r.uuid, r.raw);
    return out;
  }

  async forEachObject(datasetId: string, fn: (type: string, raw: string) => void): Promise<void> {
    const rows = (await this.db.all(
      `SELECT type, raw FROM objects WHERE dataset_id = ?`, datasetId,
    )) as { type: string; raw: string }[];
    for (const r of rows) fn(r.type, r.raw);
  }

  async close(): Promise<void> {
    await this.db.close();
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
