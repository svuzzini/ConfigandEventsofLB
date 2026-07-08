/**
 * Ingest orchestrator: stream a dump from disk, and in a single pass both
 * (a) persist each object to DuckDB in batches, and (b) register it in the
 * reference graph. After the pass, resolve the graph edges and persist a
 * dataset summary row.
 */
import { stat } from 'node:fs/promises';
import {
  hasIdentity,
  getString,
  refName,
  type AviObject,
  type IngestResult,
} from '@avi/shared';
import { streamAviConfig } from './stream-parse.js';
import { RefGraph } from '../graph/ref-graph.js';
import type { Store, StoredRow } from '../db/store.js';
import { log } from '../util/logger.js';

const BATCH_SIZE = 2000;

export async function ingestFile(args: {
  store: Store;
  datasetId: string;
  filePath: string;
  fileName: string;
}): Promise<{ result: IngestResult; graph: RefGraph }> {
  const { store, datasetId, filePath, fileName } = args;
  const started = Date.now();
  const { size: bytes } = await stat(filePath);

  const graph = new RefGraph();
  const typeSet = new Set<string>();
  const metaEntries: [string, unknown][] = [];
  let objectCount = 0;
  let batch: StoredRow[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const toWrite = batch;
    batch = [];
    await store.insertObjects(toWrite);
  };

  await streamAviConfig(filePath, {
    onMeta: (key, value) => {
      metaEntries.push([key, value]);
    },
    onObject: async (type, obj) => {
      if (!hasIdentity(obj)) return; // skip non-identified array elements
      const o = obj as AviObject;
      const canonical = graph.addObject(type, obj);
      if (canonical === null) return;

      typeSet.add(type);
      objectCount++;
      batch.push({
        datasetId,
        uuid: canonical,
        type,
        name: getString(o, 'name') ?? null,
        tenant: refName(o['tenant_ref']) || null,
        cloud: refName(o['cloud_ref']) || null,
        raw: JSON.stringify(obj),
      });
      if (batch.length >= BATCH_SIZE) await flush();
    },
  });
  await flush();

  graph.resolve();

  if (metaEntries.length > 0) await store.insertMeta(datasetId, metaEntries);

  const result: IngestResult = {
    datasetId,
    fileName,
    bytes,
    objectCount,
    typeCount: typeSet.size,
    edgeCount: graph.edges,
    danglingRefCount: graph.dangling,
    meta: metaEntries.length > 0 ? Object.fromEntries(metaEntries) : null,
    parseMs: Date.now() - started,
  };

  await store.recordDataset({
    dataset_id: datasetId,
    file_name: fileName,
    bytes,
    object_count: objectCount,
    type_count: typeSet.size,
    edge_count: graph.edges,
    dangling_count: graph.dangling,
    created_at: new Date().toISOString(),
  });

  log.info('ingest complete', {
    datasetId, objectCount, types: typeSet.size, edges: graph.edges,
    dangling: graph.dangling, ms: result.parseMs,
  });
  return { result, graph };
}

/** Rebuild the in-memory graph from persisted objects (cold-cache / restart). */
export async function rebuildGraph(store: Store, datasetId: string): Promise<RefGraph> {
  const graph = new RefGraph();
  await store.forEachObject(datasetId, (type, raw) => {
    try {
      graph.addObject(type, JSON.parse(raw));
    } catch (err) {
      log.warn('skip unparseable stored object', { datasetId, err: String(err) });
    }
  });
  graph.resolve();
  return graph;
}
