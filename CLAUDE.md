# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Avi Config Analyzer — a **single self-contained HTML file** (`avi-analyzer.html`)
that parses a VMware Avi (NSX ALB) controller configuration export (one large
JSON object keyed by object type) entirely in the browser and presents it as an
object graph: inventory, object explorer, per-object dependency graph, hygiene
findings. Zero install: open the file via `file://`, drop the export on it. No
build step, no dependencies, no network — a strict CSP (`default-src 'none'`)
makes requests impossible; keep it that way.

`legacy/avi_config_inspector.html` and `docs/CODE_REVIEW.md` are historical.
The previous client-server monorepo (`packages/`) was removed in favor of this
file; it lives in git history if a server-backed design is ever needed again
(inputs > ~500 MB).

## Commands

```bash
npm test                                  # node --test tools/tests/*.test.mjs (Node >= 20, no installs)
node --test tools/tests/scanner.test.mjs  # single suite
```

There is no build. The HTML file is the source of truth; `tools/extract-app.mjs`
pulls the inline `<script type="module" id="app">` out of it and imports it via
a data: URL so tests run against the exact shipped code. The module's UI half is
gated behind `typeof document !== 'undefined'`, which is what makes it loadable
in Node — keep new UI code inside `boot()`.

## Architecture (all inside avi-analyzer.html, in order)

- **refs** — the single home for `*_ref` string parsing (uuid variants,
  `#fragment` / `?name=` forms). Never re-implement ref parsing elsewhere.
- **ConfigScanner / scanBlob** — streaming depth-counting slicer. Finds each
  array element's exact character range and hands the slice to native
  `JSON.parse`; transient memory is O(largest object), never O(file). Do NOT
  replace this with a whole-file `JSON.parse` (multi-GB heap on big exports) or
  a token-at-a-time JS tokenizer (measured 8× slower than native parse).
  `scanBlob` reads `blob.stream()` chunk by chunk — each await is the yield
  point that keeps the progress bar painting; don't make it synchronous.
- **RefGraph** — lightweight nodes (uuid/type/name/tenant/cloud) + edges.
  Two-phase: `addObject()` stashes edge specs, one `resolve()` matches by uuid
  variant first, then (type, name). Guarded by `hasIdentity` — objects need a
  name or uuid to be indexed.
- **Dataset** — the in-memory store: one raw JSON slice per object
  (serialization for free), parsed on demand; caches inventory, per-type
  columns, per-column sort values (built chunked+yielding), and the hygiene
  report.
- **hygiene** — pure rules over (dataset, graph). Counts are always exact; at
  most `MAX_EXEMPLARS` (500) findings kept per rule — never render or retain
  unbounded findings. New rules follow the `add(ruleId, severity, ...)` pattern.
- **search** — `SearchIndex`: an inverted token index (token → doc ids)
  built ONCE per dataset, lazily on first search (`Dataset.searchIndex()`
  caches the build promise; a superseded keystroke never restarts it).
  Queries scan only the vocabulary, never the corpus — do not regress to
  per-keystroke slice scans. `searchDataset`: terms split on any char
  outside `[a-z0-9._-]` (so `ip:port` ≡ `ip port`), AND-ed,
  substring-of-token matched, never regex-compiled. Exact `total` and
  `byType` facet counts always; at most `MAX_SEARCH_RESULTS` (500)
  retained (name matches prioritized), scored/snippeted only within that
  bound. `searchSnippets` extracts context via a nearest-preceding-key
  heuristic that degrades to null.
- **ui** — vanilla DOM in `boot()`. Five views; every list is paginated; only
  the visible page's objects are ever parsed for display. Charts are plain SVG
  (bars, slice-and-dice treemap, layered BFS dependency graph — deterministic,
  no physics). Keep light/dark via `prefers-color-scheme` and WCAG AA contrast.

## Invariants

- **Version tolerance**: Avi schema drifts across 18.x–22.x. Objects are open
  bags read via `getString`/`getBool` accessors; unknown fields flow through
  untouched (raw slices guarantee this). Mark schema guesses with
  `// ASSUMPTION` comments (existing convention).
- Parse paths degrade (skip / return null) rather than throw; scanner errors
  carry a character `offset` and are surfaced to the user in plain language.
- Everything is bounded: pagination for tables, `MAX_GRAPH_NODES`/`MAX_GRAPH_DEPTH`
  for graphs, `MAX_EXEMPLARS` for hygiene, a 2 MB cap on JSON syntax
  highlighting. Any new view must have an explicit answer for "what happens at
  100k items".
- Tests in `tools/tests/` must keep passing against the extracted module — if
  you rename an export in the HTML, update the tests.
