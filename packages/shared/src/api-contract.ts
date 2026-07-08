/**
 * API contract — shared request/response DTOs.
 *
 * The web client imports these exact types, so the wire format is checked by the
 * compiler on both ends. No `any`.
 */

import type { AviObject } from './avi-types.js';

/** Lightweight node returned in listings and graph responses (no full payload). */
export interface NodeSummary {
  readonly uuid: string;
  readonly type: string;
  readonly name: string | null;
  readonly tenant: string | null;
  readonly cloud: string | null;
}

/** One edge in the resolved reference graph. */
export interface RefEdge {
  /** Field on the source object that held the reference, e.g. "pool_ref". */
  readonly field: string;
  /** Source object UUID. */
  readonly from: string;
  /** Resolved target UUID, or null when the ref could not be resolved (dangling). */
  readonly to: string | null;
  /** The name carried by the ref itself (useful when `to` is null). */
  readonly refName: string | null;
  /** How the target was matched: uuid | name | none. */
  readonly resolvedBy: 'uuid' | 'name' | 'none';
}

// ---- POST /api/datasets (ingest) ----
export interface IngestResult {
  readonly datasetId: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly objectCount: number;
  readonly typeCount: number;
  readonly edgeCount: number;
  readonly danglingRefCount: number;
  readonly meta: Record<string, unknown> | null;
  readonly parseMs: number;
}

// ---- GET /api/datasets/:id/inventory ----
export interface InventoryBucket {
  readonly key: string;
  readonly count: number;
}
export interface Inventory {
  readonly totalObjects: number;
  readonly byType: readonly InventoryBucket[];
  readonly byTenant: readonly InventoryBucket[];
  readonly byCloud: readonly InventoryBucket[];
}

// ---- GET /api/datasets/:id/types/:type/objects ----
export type SortDir = 'asc' | 'desc';
export interface ObjectListQuery {
  readonly search?: string;
  readonly sort?: string; // column key: name | uuid | tenant | cloud | <scalar field>
  readonly dir?: SortDir;
  readonly offset?: number;
  readonly limit?: number;
}
export interface ObjectListPage {
  readonly type: string;
  readonly total: number; // total matching the filter, before pagination
  readonly offset: number;
  readonly limit: number;
  /** Column keys the server chose for this type (name/uuid/tenant + scalars). */
  readonly columns: readonly string[];
  readonly rows: readonly ObjectRow[];
}
export interface ObjectRow extends NodeSummary {
  /** Scalar values for the chosen columns (stringified for display). */
  readonly cells: Record<string, string | null>;
}

// ---- GET /api/datasets/:id/objects/:uuid ----
export interface ObjectDetail {
  readonly node: NodeSummary;
  /** The full, unmodified source object. */
  readonly raw: AviObject;
  /** Outgoing edges (this object's *_ref fields), resolved. */
  readonly outgoing: readonly RefEdge[];
  /** Incoming edges (who references this object). */
  readonly incoming: readonly RefEdge[];
}

// ---- GET /api/datasets/:id/objects/:uuid/graph ----
export interface GraphNode extends NodeSummary {
  /** Depth from the root (root = 0). */
  readonly depth: number;
}
export interface DependencyGraph {
  readonly root: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly RefEdge[];
  /** True if traversal hit the depth/size cap and was truncated. */
  readonly truncated: boolean;
}

// ---- GET /api/datasets/:id/hygiene ----
export type HygieneSeverity = 'critical' | 'warning' | 'info';
export type HygieneRuleId =
  | 'orphaned-pool'
  | 'orphaned-poolgroup'
  | 'unused-certificate'
  | 'unused-healthmonitor'
  | 'disabled-virtualservice'
  | 'expired-certificate'
  | 'expiring-certificate'
  | 'dangling-reference'
  | 'default-certificate-in-use'
  | 'placeholder';

export interface HygieneFinding {
  readonly ruleId: HygieneRuleId;
  readonly severity: HygieneSeverity;
  readonly title: string;
  readonly detail: string;
  /** The object the finding is about. */
  readonly subject: NodeSummary;
  /** Optional extra structured context (e.g. daysUntilExpiry). */
  readonly meta?: Record<string, string | number | boolean>;
}
export interface HygieneReport {
  readonly generatedAt: string;
  readonly findings: readonly HygieneFinding[];
  readonly countsBySeverity: Record<HygieneSeverity, number>;
  readonly countsByRule: Record<string, number>;
}

/** Uniform API error envelope. */
export interface ApiError {
  readonly error: string;
  readonly detail?: string;
}
