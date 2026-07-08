/**
 * CLI: ingest a dump straight into the store without going through HTTP.
 *   node --loader ts-node/esm src/cli/ingest.ts <path-to-config.json> [dbPath]
 */
import { basename } from 'node:path';
import { openStore } from '../db/store.js';
import { ingestFile } from '../ingest/load.js';
import { newDatasetId } from '../util/ids.js';

async function main(): Promise<void> {
  const [, , filePath, dbPath = 'data/avi.duckdb'] = process.argv;
  if (!filePath) {
    process.stderr.write('usage: ingest <config.json> [dbPath]\n');
    process.exit(2);
  }
  const store = await openStore(dbPath);
  const datasetId = newDatasetId();
  const { result } = await ingestFile({
    store, datasetId, filePath, fileName: basename(filePath),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await store.close();
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
