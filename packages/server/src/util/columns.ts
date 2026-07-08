/**
 * Server-side column detection for the object explorer. Chooses a small set of
 * informative scalar columns for a given object type by sampling objects.
 */
import { isScalar, refName, type AviObject } from '@avi/shared';

const BASE_SKIP = new Set([
  'name', 'uuid', 'tenant_ref', 'cloud_ref', 'url', 'configpb_attributes',
  '_last_modified', 'labels', 'markers',
]);
const PREFERRED: Record<string, number> = {
  type: 5, enabled: 4, is_federated: 2, os_type: 2, vrf: 2, ssl_profile_ref: 1,
};
const MAX_COLUMNS = 4;

export function detectColumns(sample: readonly AviObject[]): string[] {
  const present: Record<string, number> = {};
  const scalar: Record<string, number> = {};
  const n = Math.min(sample.length, 100);
  for (let i = 0; i < n; i++) {
    const o = sample[i];
    if (!o) continue;
    for (const [k, v] of Object.entries(o)) {
      if (BASE_SKIP.has(k)) continue;
      present[k] = (present[k] ?? 0) + 1;
      // A `*_ref` string is scalar-displayable (we render its name).
      if (isScalar(v) || (typeof v === 'string' && k.endsWith('_ref'))) {
        scalar[k] = (scalar[k] ?? 0) + 1;
      }
    }
  }
  const candidates = Object.keys(present).filter(
    (k) => (scalar[k] ?? 0) >= (present[k] ?? 1) * 0.6,
  );
  candidates.sort((a, b) => {
    const pa = PREFERRED[a] ?? 0;
    const pb = PREFERRED[b] ?? 0;
    if (pb !== pa) return pb - pa;
    const sa = scalar[a] ?? 0;
    const sb = scalar[b] ?? 0;
    if (sb !== sa) return sb - sa;
    return a.localeCompare(b);
  });
  return candidates.slice(0, MAX_COLUMNS);
}

/** Stringify a cell value for display; resolve refs to their names. */
export function cellValue(o: AviObject, key: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return key.endsWith('_ref') ? refName(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}
