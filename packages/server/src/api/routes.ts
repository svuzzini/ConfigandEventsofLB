/**
 * REST API. Every handler is fully implemented; errors return the shared
 * ApiError envelope with an appropriate status.
 */
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import type {
  AviObject,
  DependencyGraph,
  Inventory,
  ObjectDetail,
  ObjectListPage,
  ObjectRow,
} from '@avi/shared';
import type { Registry } from '../registry.js';
import { ingestFile } from '../ingest/load.js';
import { newDatasetId } from '../util/ids.js';
import { cellValue } from '../util/columns.js';
import { log } from '../util/logger.js';

const MAX_LIMIT = 500;

export function makeRouter(registry: Registry, dataDir: string): Router {
  const router = Router();

  // --- Ingest: stream the request body to disk, then parse. ---
  router.post('/datasets', async (req: Request, res: Response) => {
    const datasetId = newDatasetId();
    const fileName = decodeURIComponent(String(req.query['name'] ?? 'upload.json'));
    const tmpPath = join(dataDir, `${datasetId}.json`);
    try {
      await pipeline(req, createWriteStream(tmpPath));
      const { result, graph } = await ingestFile({
        store: registry.store, datasetId, filePath: tmpPath, fileName,
      });
      registry.putGraph(datasetId, graph);
      res.status(201).json(result);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      log.error('ingest failed', { datasetId, err: String(err) });
      res.status(400).json({ error: 'ingest_failed', detail: String(err) });
    }
  });

  // --- List datasets. ---
  router.get('/datasets', async (_req, res) => {
    const rows = await registry.store.listDatasets();
    res.json(rows);
  });

  // --- Summary (dataset record + meta). ---
  router.get('/datasets/:id/summary', async (req, res) => {
    const rec = await registry.store.getDataset(req.params.id!);
    if (!rec) return notFound(res, 'dataset');
    const meta = await registry.store.getMeta(req.params.id!);
    return res.json({ ...rec, meta });
  });

  // --- Inventory rollups. ---
  router.get('/datasets/:id/inventory', async (req, res) => {
    const id = req.params.id!;
    const rec = await registry.store.getDataset(id);
    if (!rec) return notFound(res, 'dataset');
    const inv = await registry.store.inventory(id);
    const body: Inventory = {
      totalObjects: inv.total,
      byType: inv.byType,
      byTenant: inv.byTenant,
      byCloud: inv.byCloud,
    };
    return res.json(body);
  });

  // --- Object list for a type (filter/sort/paginate). ---
  router.get('/datasets/:id/types/:type/objects', async (req, res) => {
    const id = req.params.id!;
    const type = req.params.type!;
    const rec = await registry.store.getDataset(id);
    if (!rec) return notFound(res, 'dataset');

    const search = strParam(req, 'search');
    const sort = strParam(req, 'sort') ?? 'name';
    const dir = strParam(req, 'dir') === 'desc' ? 'desc' : 'asc';
    const offset = Math.max(0, intParam(req, 'offset', 0));
    const limit = Math.min(MAX_LIMIT, Math.max(1, intParam(req, 'limit', 50)));

    const columns = await registry.getColumns(id, type);
    const { total, rows } = await registry.store.listObjects({
      datasetId: id, type, search, sort, dir, offset, limit,
    });

    const outRows: ObjectRow[] = rows.map((r) => {
      let obj: AviObject = {};
      try {
        obj = JSON.parse(r.raw) as AviObject;
      } catch {
        /* leave empty */
      }
      const cells: Record<string, string | null> = {};
      for (const c of columns) cells[c] = cellValue(obj, c);
      return {
        uuid: r.uuid, type: r.type, name: r.name, tenant: r.tenant, cloud: r.cloud, cells,
      };
    });

    const page: ObjectListPage = { type, total, offset, limit, columns, rows: outRows };
    return res.json(page);
  });

  // --- Object detail + resolved edges. ---
  router.get('/datasets/:id/objects/:uuid', async (req, res) => {
    const id = req.params.id!;
    const uuid = req.params.uuid!;
    const graph = await registry.getGraph(id);
    if (!graph) return notFound(res, 'dataset');
    const node = graph.getNode(uuid);
    const stored = await registry.store.getRaw(id, node ? node.uuid : uuid);
    if (!node || !stored) return notFound(res, 'object');

    let raw: AviObject = {};
    try {
      raw = JSON.parse(stored.raw) as AviObject;
    } catch {
      /* leave empty */
    }
    const detail: ObjectDetail = {
      node,
      raw,
      outgoing: graph.outgoingOf(node.uuid),
      incoming: graph.incomingOf(node.uuid),
    };
    return res.json(detail);
  });

  // --- Dependency graph for a VirtualService (or any object). ---
  router.get('/datasets/:id/objects/:uuid/graph', async (req, res) => {
    const id = req.params.id!;
    const uuid = req.params.uuid!;
    const graph = await registry.getGraph(id);
    if (!graph) return notFound(res, 'dataset');
    const depth = Math.min(20, Math.max(1, intParam(req, 'depth', 12)));
    const dep: DependencyGraph | null = graph.dependencyGraph(uuid, depth);
    if (!dep) return notFound(res, 'object');
    return res.json(dep);
  });

  // --- Hygiene report. ---
  router.get('/datasets/:id/hygiene', async (req, res) => {
    const id = req.params.id!;
    const graph = await registry.getGraph(id);
    if (!graph) return notFound(res, 'dataset');
    const { runHygiene } = await import('../hygiene/rules.js');
    const report = await runHygiene(registry.store, graph, id);
    return res.json(report);
  });

  return router;
}

function notFound(res: Response, what: string): Response {
  return res.status(404).json({ error: 'not_found', detail: `${what} not found` });
}
function strParam(req: Request, key: string): string | null {
  const v = req.query[key];
  return typeof v === 'string' && v !== '' ? v : null;
}
function intParam(req: Request, key: string, dflt: number): number {
  const v = req.query[key];
  if (typeof v !== 'string') return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
