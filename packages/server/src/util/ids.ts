import { randomUUID } from 'node:crypto';

/** Opaque dataset id, safe as a filename and URL path segment. */
export function newDatasetId(): string {
  return 'ds_' + randomUUID().replace(/-/g, '').slice(0, 16);
}
