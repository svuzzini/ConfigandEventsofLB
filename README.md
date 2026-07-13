# Avi Config Analyzer

Ingest a VMware Avi (NSX ALB) controller configuration export and explore it as a
**queryable object graph**: inventory rollups, a filterable object explorer,
per-VirtualService dependency chains, and config-hygiene signals.

The design priority is **correct cross-object reference resolution**. Large dumps
(hundreds of MB) are parsed **server-side by streaming** — the browser never loads
the raw file, and the Node heap never holds more than one object at a time during
ingest.

---

## Why this architecture

```
                 ┌──────────────────────── Browser (React + TS) ────────────────────────┐
   upload file   │  Inventory │ Object Explorer │ Relationship graph │ Hygiene panel     │
   (streamed)    │  (ECharts) │ (paged table)   │ (ECharts graph)    │ (findings table)  │
        │        └───────────────────────────────▲──────────────────────────────────────┘
        │ POST /api/datasets (raw body)           │ small JSON: aggregates / pages / graph
        ▼                                          │
┌──────────────────────────────── Server (Node + TS) ─────────────────────────────────────┐
│  Ingest ──────────────► Index ──────────────────────► API                                │
│  streaming JSON parser  in-memory RefGraph (light      REST over Express                  │
│  (stream-json, 1 obj    nodes + resolved edges)        inventory / list / detail /        │
│  in memory at a time)          +                       graph / hygiene                    │
│         │               DuckDB or node:sqlite (raw     ▲                                  │
│         └──── batches ─► payloads, columnar rollups) ──┘                                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Ingest** — `stream-json` tokenises the file; a depth-aware state machine assembles
  one array element at a time and hands it off, so peak heap is `O(largest object)`,
  not `O(file)`. Each object is (a) batched into the store and (b) registered in the
  graph in a single pass.
- **Index** — the `RefGraph` holds only *lightweight* nodes (`uuid, type, name, tenant,
  cloud`) plus resolved edges, so even a multi-million-object dump stays small in RAM
  and gives O(1) neighbour lookups. Full payloads live in the store, fetched on demand.
- **API** — Express REST. All responses are paginated or aggregated; the browser is
  never handed the whole dump.
- **UI** — React + TypeScript, ECharts for every chart (treemap, bars, force graph).

**Backend choice (SQLite default, DuckDB opt-in).** Storage sits behind a `Store`
interface. The default is Node's built-in **`node:sqlite`** — zero native build, ships
with the runtime, and satisfies the "single-binary / minimal-dependency" goal better
than anything external; its bundled JSON1 gives `json_extract` for schema-free sort and
projection. For very large deployments where inventory rollups over millions of rows
dominate, set `STORE=duckdb` to use the columnar engine instead — same SQL semantics,
same API. Reference resolution itself is deliberately **not** done in SQL: it is pointer
chasing, which the in-memory graph does far better than recursive joins.

**Charting: ECharts.** Canvas rendering stays smooth with dozens of chart categories
and the hundreds of nodes/edges a relationship graph produces — where SVG libraries
(Recharts) bog down — and one engine covers treemap, bar, and force-graph, so it is a
single dependency rather than three.

---

## Quick start

Requires **Node ≥ 20.6** (the default store needs `node:sqlite`, GA-ish in 22; this repo
is developed on Node 22).

```bash
npm install                 # installs shared + server + web workspaces
npm run build:shared        # compile the shared types package once

# Terminal 1 — API (defaults: PORT=4000, STORE=sqlite, DATA_DIR=./data)
npm run dev:server

# Terminal 2 — web UI (proxies /api to :4000)
npm run dev:web             # http://localhost:5173
```

Then drop `examples/sample_avi_config.json` onto the upload zone.

**CLI ingest** (no HTTP):

```bash
npm run build -w @avi/server
node packages/server/dist/cli/ingest.js examples/sample_avi_config.json data/avi.sqlite
```

**Use the columnar backend:** `STORE=duckdb npm run dev:server` (installs the optional
`duckdb-async` dependency; falls back cleanly to SQLite if absent).

**Tests:**

```bash
npm run build -w @avi/shared && npm run build -w @avi/server
node --test packages/server/dist/**/*.test.js
```

---

## API contract

Base path `/api`. All errors return `{ "error": string, "detail"?: string }`.
Full response types live in `packages/shared/src/api-contract.ts`.

| Method | Path | Purpose | Response |
|---|---|---|---|
| `POST` | `/datasets?name=<file>` | Ingest a dump. **Body = raw JSON**, streamed. | `IngestResult` |
| `GET` | `/datasets` | List ingested datasets. | `DatasetRecord[]` |
| `GET` | `/datasets/:id/summary` | Dataset record + export META. | `DatasetRecord & { meta }` |
| `GET` | `/datasets/:id/inventory` | Counts by type / tenant / cloud. | `Inventory` |
| `GET` | `/datasets/:id/types/:type/objects` | Paged, filtered, sorted objects. | `ObjectListPage` |
| `GET` | `/datasets/:id/objects/:uuid` | One object: raw + in/out edges. | `ObjectDetail` |
| `GET` | `/datasets/:id/objects/:uuid/graph?depth=` | Dependency chain (BFS). | `DependencyGraph` |
| `GET` | `/datasets/:id/hygiene` | Hygiene findings. | `HygieneReport` |

Object-list query params: `search`, `sort` (column or JSON field), `dir` (`asc`/`desc`),
`offset`, `limit` (≤ 500).

### Example shapes

```jsonc
// POST /api/datasets  → 201
{ "datasetId": "ds_bf28…", "fileName": "cfg.json", "bytes": 7141,
  "objectCount": 23, "typeCount": 12, "edgeCount": 49, "danglingRefCount": 1,
  "meta": { "META": { "version": { "Version": "22.1.3" } } }, "parseMs": 11 }

// GET …/objects/virtualservice-web-0001/graph
{ "root": "virtualservice-web-0001", "truncated": false,
  "nodes": [ { "uuid": "…", "type": "VsVip", "name": "web-vip", "depth": 1 }, … ],
  "edges": [ { "field": "vsvip_ref", "from": "…", "to": "vsvip-web-0001",
              "refName": "web-vip", "resolvedBy": "uuid" }, … ] }

// GET …/hygiene
{ "generatedAt": "…", "countsBySeverity": { "critical": 2, "warning": 3, "info": 4 },
  "findings": [ { "ruleId": "expired-certificate", "severity": "critical",
                  "subject": { "type": "SSLKeyAndCertificate", "name": "legacy-expired" },
                  "detail": "Certificate expired … ago" }, … ] }
```

---

## Reference resolution (the core)

`*_ref` / `*_refs` fields carry URLs like
`https://ctrl/api/pool/pool-84cf…#web-pool`. On ingest, every object is indexed by
**all uuid variants** (prefixed `pool-…` and bare) **and** by `type+name`. Edges are
then resolved uuid-first, **falling back to type+name** when the uuid does not match
(schema drift across versions / cross-controller copies). Unresolved edges are recorded
as **dangling** and surfaced in hygiene. Refs are collected **recursively**, so nested
references (e.g. `poolgroup.members[].pool_ref`,
`httppolicyset…rules[].switching_action.pool_ref`) are captured too.

See `packages/shared/src/refs.ts` and `packages/server/src/graph/ref-graph.ts`.

## Version tolerance

Objects are modelled as **open** bags (`AviObject` = known optional keys + index
signature). Unknown fields flow through untouched; no field is required. Where a field
location is not guaranteed across versions it is marked `// ASSUMPTION` in code (e.g.
certificate `not_after`).

## Layout

```
packages/
  shared/   TS types + ref parsing (imported by server AND web)
  server/   streaming ingest · RefGraph · Store (sqlite/duckdb) · Express API
  web/      React + ECharts dashboard
examples/   sample_avi_config.json (sanitized)
```

## Deploying on a server (single process)

`npm run build` produces everything; the API server then also serves the web UI
(`packages/web/dist`, auto-detected — override with `WEB_DIST`), so one Node process
on one port is a complete deployment:

```bash
npm ci && npm run build
PORT=4000 DATA_DIR=/var/lib/avi-analyzer node packages/server/dist/index.js
# → http://<server>:4000
```

Env: `PORT` (4000), `HOST` (0.0.0.0), `DATA_DIR` (./data), `DB_PATH`, `STORE`
(`sqlite`|`duckdb`), `WEB_DIST`.

For a real installation put it behind systemd + a reverse proxy (nginx/caddy) for
TLS; the app itself has **no authentication**, so don't expose config dumps to the
open internet without one.
