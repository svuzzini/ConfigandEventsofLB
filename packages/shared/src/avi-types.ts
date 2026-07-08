/**
 * Avi object model — deliberately OPEN.
 *
 * Version tolerance requirement: schema drifts across 18.x .. 22.x. We therefore
 * never model objects as closed interfaces. Every object is an `AviObject`: a
 * bag of unknown-typed fields with a handful of conventionally-present keys typed
 * as optional. Unknown fields flow through untouched; no field is ever required.
 */

/** Any config object from the export. Fields beyond the known ones are preserved. */
export interface AviObject {
  /** Human name. Present on virtually all first-class objects. */
  readonly name?: unknown;
  /** Type-prefixed UUID, e.g. "pool-84cf...". Present on first-class objects. */
  readonly uuid?: unknown;
  /** Self URL. */
  readonly url?: unknown;
  /** Reference to owning tenant. */
  readonly tenant_ref?: unknown;
  /** Reference to owning cloud (not present on all types). */
  readonly cloud_ref?: unknown;
  /** Everything else. Access via helpers below; never assume a shape. */
  readonly [key: string]: unknown;
}

/**
 * Object types we attach first-class meaning to (dashboard groupings, hygiene
 * rules, relationship traversal). This list is NOT a gate — any top-level array
 * key in the dump is ingested. It only drives labels and rule targeting.
 */
export const KNOWN_TYPES = [
  'VirtualService',
  'VsVip',
  'Pool',
  'PoolGroup',
  'HealthMonitor',
  'ApplicationProfile',
  'NetworkProfile',
  'ApplicationPersistenceProfile',
  'SSLProfile',
  'SSLKeyAndCertificate',
  'PKIProfile',
  'ServiceEngine',
  'ServiceEngineGroup',
  'Cloud',
  'VrfContext',
  'Network',
  'VsDataScriptSet',
  'HTTPPolicySet',
  'NetworkSecurityPolicy',
  'WafPolicy',
  'WafProfile',
  'AuthProfile',
  'Tenant',
  'Role',
  'User',
  'GslbService',
  'IpAddrGroup',
  'StringGroup',
] as const;

export type KnownType = (typeof KNOWN_TYPES)[number];

const KNOWN_SET = new Set<string>(KNOWN_TYPES);
export function isKnownType(t: string): t is KnownType {
  return KNOWN_SET.has(t);
}

// ---- safe scalar accessors (never throw, never assume) ----

export function getString(o: AviObject, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}
export function getBool(o: AviObject, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === 'boolean' ? v : undefined;
}
export function getNumber(o: AviObject, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
export function getArray(o: AviObject, key: string): readonly unknown[] {
  const v = o[key];
  return Array.isArray(v) ? v : [];
}

export function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Objects are considered "identified" (worth indexing) if they carry a name or uuid. */
export function hasIdentity(o: unknown): o is AviObject {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
  const rec = o as Record<string, unknown>;
  const n = rec['name'];
  const u = rec['uuid'];
  const nOk = typeof n === 'string' ? n.trim() !== '' : n != null;
  const uOk = typeof u === 'string' ? u.trim() !== '' : u != null;
  return nOk || uOk;
}
