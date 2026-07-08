/**
 * Dataset registry: owns the Store and caches per-dataset in-memory graphs and
 * detected columns. On a cache miss the graph is rebuilt from persisted objects,
 * so the API is correct across server restarts without re-uploading.
 */
import type { AviObject, HygieneReport } from '@avi/shared';
import { openStore, type Store } from './db/store.js';
import { RefGraph } from './graph/ref-graph.js';
import { rebuildGraph } from './ingest/load.js';
import { detectColumns } from './util/columns.js';

export class Registry {
  private readonly graphs = new Map<string, RefGraph>();
  private readonly columns = new Map<string, string[]>(); // `${ds}\0${type}` -> cols
  private readonly hygiene = new Map<string, HygieneReport>();

  private constructor(readonly store: Store) {}

  static async create(dbPath: string): Promise<Registry> {
    return new Registry(await openStore(dbPath));
  }

  putGraph(datasetId: string, graph: RefGraph): void {
    this.graphs.set(datasetId, graph);
  }

  async getGraph(datasetId: string): Promise<RefGraph | null> {
    const cached = this.graphs.get(datasetId);
    if (cached) return cached;
    const rec = await this.store.getDataset(datasetId);
    if (!rec) return null;
    const graph = await rebuildGraph(this.store, datasetId);
    this.graphs.set(datasetId, graph);
    return graph;
  }

  /** Columns for a type, sampled from persisted rows and cached. */
  async getColumns(datasetId: string, type: string): Promise<string[]> {
    const key = datasetId + '\0' + type;
    const cached = this.columns.get(key);
    if (cached) return cached;
    const { rows } = await this.store.listObjects({
      datasetId, type, search: null, sort: 'name', dir: 'asc', offset: 0, limit: 100,
    });
    const sample: AviObject[] = [];
    for (const r of rows) {
      try {
        sample.push(JSON.parse(r.raw) as AviObject);
      } catch {
        /* skip */
      }
    }
    const cols = detectColumns(sample);
    this.columns.set(key, cols);
    return cols;
  }

  getHygiene(datasetId: string): HygieneReport | null {
    return this.hygiene.get(datasetId) ?? null;
  }

  putHygiene(datasetId: string, report: HygieneReport): void {
    this.hygiene.set(datasetId, report);
  }

  invalidate(datasetId: string): void {
    this.graphs.delete(datasetId);
    this.hygiene.delete(datasetId);
    for (const key of this.columns.keys()) {
      if (key.startsWith(datasetId + '\0')) this.columns.delete(key);
    }
  }
}
