/** HTTP server bootstrap. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import cors from 'cors';
import { Registry } from './registry.js';
import { makeRouter } from './api/routes.js';
import { log } from './util/logger.js';

const PORT = Number.parseInt(process.env['PORT'] ?? '4000', 10);
const DATA_DIR = process.env['DATA_DIR'] ?? join(process.cwd(), 'data');
const DB_PATH = process.env['DB_PATH'] ?? join(DATA_DIR, 'avi.duckdb');

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const registry = await Registry.create(DB_PATH);

  const app = express();
  app.use(cors());
  // NB: no global express.json() — /datasets streams the raw body itself.
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', makeRouter(registry, DATA_DIR));

  app.listen(PORT, () => log.info('server listening', { port: PORT, dataDir: DATA_DIR }));
}

main().catch((err) => {
  log.error('fatal', { err: String(err) });
  process.exit(1);
});
