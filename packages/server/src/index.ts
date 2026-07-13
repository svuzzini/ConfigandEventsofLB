/** HTTP server bootstrap. */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Registry } from './registry.js';
import { makeRouter } from './api/routes.js';
import { log } from './util/logger.js';

const PORT = Number.parseInt(process.env['PORT'] ?? '4000', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const DATA_DIR = process.env['DATA_DIR'] ?? join(process.cwd(), 'data');
const DB_PATH = process.env['DB_PATH'] ?? join(DATA_DIR, 'avi.duckdb');

/**
 * Locate the built web UI so a single process serves both API and dashboard.
 * Override with WEB_DIST; otherwise resolve relative to this file so it works
 * regardless of the process's working directory.
 */
function findWebDist(): string | null {
  const explicit = process.env['WEB_DIST'];
  if (explicit) return existsSync(join(explicit, 'index.html')) ? resolve(explicit) : null;
  const here = dirname(fileURLToPath(import.meta.url)); // .../packages/server/dist
  const candidate = resolve(here, '../../web/dist');
  return existsSync(join(candidate, 'index.html')) ? candidate : null;
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const registry = await Registry.create(DB_PATH);

  const app = express();
  app.use(cors());
  // NB: no global express.json() — /datasets streams the raw body itself.
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', makeRouter(registry, DATA_DIR));

  const webDist = findWebDist();
  if (webDist) {
    // Hashed assets are immutable; index.html must revalidate so deploys show up.
    app.use(express.static(webDist, { maxAge: '1y', immutable: true, index: false }));
    app.get(/^\/(?!api\/|health$).*/, (_req, res) =>
      res.sendFile(join(webDist, 'index.html'), { headers: { 'cache-control': 'no-cache' } }),
    );
    log.info('serving web UI', { webDist });
  } else {
    log.info('web UI build not found — API only (build with: npm run build -w @avi/web)');
  }

  app.listen(PORT, HOST, () => log.info('server listening', { host: HOST, port: PORT, dataDir: DATA_DIR }));
}

main().catch((err) => {
  log.error('fatal', { err: String(err) });
  process.exit(1);
});
