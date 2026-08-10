# Avi Config Analyzer

Explore a VMware Avi (NSX ALB) controller configuration export as a **queryable
object graph**: inventory rollups, a filterable object explorer,
per-VirtualService dependency chains, and config-hygiene findings.

**Zero install, 100% client-side.** The entire application is one file:

> **[`avi-analyzer.html`](avi-analyzer.html)** — double-click it (or open via
> `file://`) in any modern browser, then drop your configuration export on it.

No server, no build step, no npm, no CDN. The page's Content-Security-Policy
(`default-src 'none'`) makes network requests impossible, so the configuration
never leaves the machine — enforced by the browser, not just promised.

## What it does

```
 drop file ──► streaming scanner ──► RefGraph ──► four views
              (one object at a      (lightweight   Inventory · Explorer ·
               time, raw slice       nodes +        Relationships · Hygiene
               kept per object)      resolved edges)
```

- **Scanner** — the export is scanned as a character stream; each array
  element's exact range is found by depth counting and handed to native
  `JSON.parse`. Transient memory is O(largest object), throughput ~80 MB/s
  (measured: 113 MB / 40k objects parsed + graphed in ~1.3 s).
- **RefGraph** — every object indexed by uuid variants and `type+name`; every
  `*_ref`/`*_refs` at any nesting depth becomes an edge, resolved uuid-first
  with a name fallback for schema drift across 18.x–22.x. Unresolved edges are
  reported as dangling.
- **Hygiene** — orphaned pools/pool groups, unused monitors/certs, disabled
  virtual services, default/expired/expiring certificates, dangling references.
  Counts are always exact; at most 500 example findings are retained per rule so
  a pathological export cannot freeze the tab.

## Where it falls over

Everything lives in tab memory (~3–4× file size). Exports up to a few hundred
MB are comfortable; around 500–800 MB the tab will hit browser heap limits. At
that size you want a local server with a disk store again — that design exists
in this repo's git history (the `packages/` monorepo, removed after this file
replaced it).

## Development

The HTML file is the source of truth. Unit tests extract its inline module and
run against the exact code the browser executes:

```bash
npm test        # = node --test tools/tests/*.test.mjs  (needs Node >= 20, no installs)
```

`examples/sample_avi_config.json` is a small export used by the tests and handy
for manual smoke checks. `legacy/avi_config_inspector.html` is the original
prototype, kept for history; `docs/CODE_REVIEW.md` reviews it.
