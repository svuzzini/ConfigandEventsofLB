# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Avi Config Analyzer — ingests a VMware Avi (NSX ALB) controller configuration export (a single large JSON file keyed by object type) and serves it as a queryable object graph with a React dashboard (inventory, object explorer, per-VirtualService dependency graph, hygiene findings). npm-workspaces monorepo: `@avi/shared` (types + ref parsing), `@avi/server` (Node/Express API), `@avi/web` (React + Vite + ECharts).

Requires Node ≥ 22 in practice (the default store uses `node:sqlite`).

## Commands

```bash
npm install                    # all workspaces
npm run build:shared           # REQUIRED once before server/web typecheck — both import @avi/shared from dist/

npm run dev:server             # API on :4000 (env: PORT, DATA_DIR=./data, STORE=sqlite|duckdb)
npm run dev:web                # Vite on :5173, proxies /api → :4000 (override with API_TARGET)

npx tsc -b tsconfig.json       # typecheck shared + server (project references)
npm run typecheck -w @avi/web  # typecheck web (separate — not in the tsc -b graph)

# Tests (node:test; compiled first — the ts-node loader path is flaky on Node 22)
npm run build -w @avi/shared && npm run build -w @avi/server
node --test packages/server/dist/**/*.test.js
# Single test file:
node --test packages/server/dist/graph/ref-graph.test.js

# CLI ingest without HTTP:
node packages/server/dist/cli/ingest.js examples/sample_avi_config.json data/avi.sqlite

# Smoke-test ingest over HTTP (body = raw JSON, streamed):
curl -X POST "http://localhost:4000/api/datasets?name=sample.json" \
  --data-binary @examples/sample_avi_config.json -H "content-type: application/octet-stream"
```

## Architecture

One-pass pipeline, server-side: **streaming parse → (store + graph) → REST → thin UI**. The browser never receives the raw dump; every API response is paginated or aggregated.

- **Ingest** (`server/src/ingest/stream-parse.ts` + `load.ts`): `stream-json` tokens drive a depth-aware state machine that assembles one array element at a time — peak heap is O(largest object), never O(file). Each object goes to the store (batched inserts) and the graph in the same pass. Do not replace this with `JSON.parse` or stream-json's `StreamObject` (which assembles whole top-level arrays).
- **RefGraph** (`server/src/graph/ref-graph.ts`): in-memory index of *lightweight* nodes (uuid/type/name/tenant/cloud) + resolved edges. Two-phase: `addObject()` collects edge specs, then a single `resolve()` matches refs by uuid variant first, then by (type, name). Full payloads live only in the store. Rebuilt lazily from the store on restart via `Registry.getGraph()`.
- **Store** (`server/src/db/store.ts` interface): `node:sqlite` default, `duckdb-async` behind `STORE=duckdb` (optional dep, falls back to SQLite if not installed). Both implement identical SQL semantics; keep them in lockstep when changing schema (e.g. indexes exist in both files).
- **API** (`server/src/api/routes.ts`): endpoint table and all request/response DTOs are in `packages/shared/src/api-contract.ts` — change the contract there first; both server and web compile against it. Hygiene reports are cached per dataset in `Registry` (datasets are immutable after ingest); anything that mutates a dataset must call `registry.invalidate()`.
- **Web** (`packages/web`): four tabs, each `React.lazy` so ECharts stays out of the initial chunk. ECharts is the modular build — new chart/component types must be registered in `web/src/components/charts/echarts.tsx` (`echarts.use([...])`) or they silently render nothing. Data fetches use monotonic-sequence guards to drop stale responses; keep that pattern for new views.

## Invariants

- **Ref parsing has one home**: `packages/shared/src/refs.ts`. Both ingest and API import it; never re-implement `*_ref` string handling elsewhere. Refs match by trailing-path uuid (both `pool-<uuid>` and bare `<uuid>` variants), falling back to `#fragment`/`?name=` name.
- **Version tolerance**: Avi schema drifts across 18.x–22.x. Never model Avi objects as closed interfaces — everything is the open `AviObject` bag in `shared/src/avi-types.ts`, read through its `getString`/`getBool`/`getArray` accessors. Unknown fields must flow through untouched. Mark schema guesses with `// ASSUMPTION` comments (existing convention).
- **No `any`** anywhere; parse paths degrade (skip/null) rather than throw.
- ESM throughout: relative imports need explicit `.js` extensions, including in `.ts` sources.
- Hygiene rules (`server/src/hygiene/rules.ts`) are pure functions over (store, graph); new rules need a `HygieneRuleId` added to the union in `api-contract.ts`.
