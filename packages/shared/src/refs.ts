/**
 * Avi object-reference parsing.
 *
 * This module is the single source of truth for interpreting `*_ref` values.
 * It is imported by BOTH the ingest pipeline and the API layer so the two can
 * never disagree about what a reference points at.
 *
 * Observed reference shapes in real controller exports (18.x .. 22.x / VCF 9.x):
 *   https://10.0.0.1/api/pool/pool-84cf...e6b#my-pool
 *   https://ctrl/api/tenant/tenant-1a2b...#admin
 *   /api/sslkeyandcertificate/sslkeyandcertificate-9f...#System-Default-Cert
 *   https://ctrl/api/vsvip/vsvip-...?name=my-vsvip&tenant=admin&cloud=Default-Cloud
 *   admin                              (bare tenant name, seen on some fields)
 *
 * The authoritative identifier is the last path segment (the object UUID, which
 * in Avi is itself type-prefixed, e.g. "pool-84cf...e6b"). The `#fragment` or
 * `?name=` carries the human-readable name. We extract everything defensively
 * and never throw on a malformed ref.
 */

/** A structurally-parsed reference. Fields are absent (undefined) when not derivable. */
export interface ParsedRef {
  /** The exact string that appeared in the source object. */
  readonly raw: string;
  /** Object type inferred from the `/api/<type>/...` path segment, lower-cased. */
  readonly objectType?: string;
  /** Last path segment — the Avi UUID (usually `<type>-<uuid>`). Primary match key. */
  readonly uuid?: string;
  /** Human name from the `#fragment` or `?name=` query param. */
  readonly name?: string;
  /** Tenant name from a `?tenant=` query param, when the ref carries one. */
  readonly tenant?: string;
  /** Cloud name from a `?cloud=` query param, when the ref carries one. */
  readonly cloud?: string;
}

const API_PATH = /\/api\/([a-z0-9_]+)\/([^/?#]+)/i;

/**
 * Parse a single `*_ref` string. Returns `null` only for non-strings or empties.
 * Never throws — unknown/odd inputs degrade to `{ raw, name: raw }`.
 */
export function parseRef(ref: unknown): ParsedRef | null {
  if (typeof ref !== 'string') return null;
  const raw = ref.trim();
  if (raw === '') return null;

  let objectType: string | undefined;
  let uuid: string | undefined;
  let name: string | undefined;
  let tenant: string | undefined;
  let cloud: string | undefined;

  // 1) /api/<type>/<id> path.
  const pathMatch = raw.match(API_PATH);
  if (pathMatch) {
    objectType = pathMatch[1]!.toLowerCase();
    uuid = decodeSegment(pathMatch[2]!);
  }

  // 2) Fragment name: everything after the first '#'.
  const hashIdx = raw.indexOf('#');
  if (hashIdx !== -1) {
    const frag = raw.slice(hashIdx + 1);
    if (frag !== '') name = decodeSegment(frag);
  }

  // 3) Query params (?name= / ?tenant= / ?cloud=). These win for name if present.
  const qIdx = raw.indexOf('?');
  if (qIdx !== -1) {
    // Strip a trailing fragment so it doesn't leak into the last param value.
    const qs = (hashIdx !== -1 && hashIdx > qIdx ? raw.slice(qIdx + 1, hashIdx) : raw.slice(qIdx + 1));
    for (const pair of qs.split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq);
      const val = decodeSegment(pair.slice(eq + 1));
      if (val === '') continue;
      if (key === 'name') name = val;
      else if (key === 'tenant') tenant = val;
      else if (key === 'cloud') cloud = val;
    }
  }

  // 4) Bare name (no /api/ path, no marker). Treat the whole thing as a name.
  if (!pathMatch && name === undefined && qIdx === -1 && hashIdx === -1) {
    name = raw;
  }

  const out: ParsedRef = { raw };
  if (objectType !== undefined) (out as Mutable<ParsedRef>).objectType = objectType;
  if (uuid !== undefined) (out as Mutable<ParsedRef>).uuid = uuid;
  if (name !== undefined) (out as Mutable<ParsedRef>).name = name;
  if (tenant !== undefined) (out as Mutable<ParsedRef>).tenant = tenant;
  if (cloud !== undefined) (out as Mutable<ParsedRef>).cloud = cloud;
  return out;
}

/**
 * Extract the display name from a ref without allocating a full ParsedRef.
 * Used on hot table-render paths. Falls back to the raw string.
 */
export function refName(ref: unknown): string {
  const parsed = parseRef(ref);
  if (!parsed) return '';
  return parsed.name ?? parsed.uuid ?? parsed.raw;
}

/**
 * Avi UUIDs are type-prefixed (`pool-<uuid>`). Given an id, return the same id
 * plus the prefix-stripped variant, so a resolver can match either convention.
 * ASSUMPTION: the prefix is the object type followed by a single '-'. Some
 * versions store the bare uuid on the object and the prefixed form in the ref
 * (or vice-versa); returning both lets the graph match without guessing which.
 */
export function uuidVariants(id: string): string[] {
  const variants = [id];
  const dash = id.indexOf('-');
  // Only strip when the head looks like a type token (letters), not a uuid hex group.
  if (dash > 0 && /^[a-z][a-z0-9_]*$/i.test(id.slice(0, dash))) {
    variants.push(id.slice(dash + 1));
  }
  return variants;
}

/** True when a field name denotes a reference (single or array of refs). */
export function isRefKey(key: string): boolean {
  return key === 'ref' || key.endsWith('_ref') || key.endsWith('_refs');
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
