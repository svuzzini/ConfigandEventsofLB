# Part 1 — Code review of `avi_config_inspector.html`

Reviewed: the single 890-line HTML/CSS/vanilla-JS file. Ranked
correctness → performance → maintainability. Bottom line up front: as a
lightweight *browser* for a small pasted config it is competent and the CSS is
genuinely nice. As the foundation for an **analytics platform over 200 MB dumps
with correct reference resolution**, the architecture is wrong in two
load-bearing ways (client-side whole-file parse; no reference graph at all), and
no amount of polishing the current structure fixes them — hence the full
refactor in Part 2.

---

### 1. [Correctness · architecture] Whole file is `JSON.parse`d in the browser — fails the primary scale requirement
`loadFile` does `FileReader.readAsText(f)` then `JSON.parse(rd.result)` and holds
the result in `state.raw` (lines **837–846**, **364**). A 200 MB file becomes a
~200 MB JS string **plus** a multi-GB parsed object tree, all on the main thread.
The tab will OOM or freeze long before that. The brief explicitly says *"do not
load 200 MB into browser memory"* — this design does exactly that, and it is the
single fact that decides the architecture.
**Fix:** parse server-side with a streaming tokenizer; the browser uploads bytes
and only ever receives paginated/aggregated JSON. → `server/src/ingest/stream-parse.ts`
keeps one object in memory at a time; `web` never calls `JSON.parse` on the dump.

### 2. [Correctness] The headline feature — reference resolution — is absent, and display-name parsing is wrong for real exports
The only ref handling is `refName()` (**315–321**), which regex-extracts
`?name=` **for display only**. There is no object index, no uuid resolution, no
incoming/outgoing edges, no dependency chain, no orphan detection. Worse, real
controller exports carry the name in a **`#fragment`** (`…/api/pool/pool-1#web-pool`),
not `?name=`, so `refName` returns the whole URL on most real data.
**Fix:** parse `type` + `uuid` + `name` from `/api/<type>/<id>#name` *and* the
`?name=`/`?tenant=` forms; index every object by uuid-variants and by `type+name`;
resolve edges uuid-first with a name fallback for version drift; record
unresolved edges as *dangling*. → `shared/src/refs.ts`, `server/src/graph/ref-graph.ts`
(9 unit tests cover uuid match, name fallback, nested refs, dangling, BFS).

### 3. [Correctness] Silent 1,000-row cap means you are not analyzing the whole config
`MAX_ROWS = 1000` (**289**); `render()` slices to it (**571**) and shows a
"narrow the filter" banner. Because filtering/sorting run only over the loaded
set, objects beyond the first 1,000 of a type are simply invisible unless you
guess a search term. For an analytics tool that is a correctness defect, not a
UX nicety.
**Fix:** server-side `COUNT(*)` + `LIMIT/OFFSET`; sort and search execute in the
store over the full set. → `ObjectListPage.total` + real pagination.

### 4. [Performance] Every keystroke rebuilds the entire table via `innerHTML` string concatenation
`searchBox` `input` → `render()` (**815–818**) with no debounce; `render` re-runs
`buildRows` (scans **all** objects, **507–517**), `sortRows`, then rebuilds up to
1,000 `<tr>` as one big string and assigns `tableWrap.innerHTML` (**616**). On a
large type this stalls the main thread on every character.
**Fix:** debounce input; render only the current 50-row page returned by the API.
→ `web/src/components/ObjectExplorer.tsx` (150 ms debounce, paged fetch).

### 5. [Correctness] Column detection samples only the first 80 objects
`detectColumns` uses `n = Math.min(objs.length, 80)` and keeps a key only if it is
scalar in ≥60% of *those* rows (**450–460**). A field that is sparse early but
common later is dropped, so the table silently omits columns that exist. Low blast
radius but a real "the view is lying" bug.
**Fix:** detect over a larger sample server-side and cache per `(dataset, type)`.
→ `server/src/util/columns.ts` + `Registry.getColumns`.

### 6. [Maintainability] One 890-line IIFE, global mutable `state`, string-built HTML, zero types, zero tests
Data logic and DOM are interleaved; `state` (**292–302**) is global and mutable;
markup is assembled with string concatenation (XSS is *mostly* contained by
`esc()`, but it is fragile and easy to regress). The brief asks for *typed
end-to-end, no `any`, error handling on all parse paths* — the draft is untyped JS
with a single `try/catch` around `JSON.parse`. None of the parse/resolve logic is
unit-testable because it is welded to the DOM.
**Fix:** TypeScript monorepo; pure, tested functions for parse/resolve/hygiene;
React for rendering. → `packages/{shared,server,web}`.

### 7. [Correctness · minor] `ingest` shape assumptions drop data quietly
`hasId` keeps only elements with a non-empty `name`/`uuid` (**344–349**) and
non-`META` top-level non-arrays are ignored entirely. That is defensible, but
there is no signal to the user about what was skipped, and META/version handling
is special-cased rather than general.
**Fix:** ingest every array key generically; capture *all* non-array top-level
keys as `meta`; report `objectCount`/`typeCount`/`danglingRefCount` back so nothing
is silently lost. → `server/src/ingest/load.ts`, `IngestResult`.

---

**What the draft got right (keep):** the type-sidebar + table + drill-to-raw-JSON
mental model is the correct shape for an object explorer; the ref-name-in-cell idea
is right (just under-implemented); syntax-highlighted JSON detail is good; the
CSS/visual system is clean. The refactor preserves all of these and adds the graph,
the streaming ingest, and the analytics the draft could not reach.
