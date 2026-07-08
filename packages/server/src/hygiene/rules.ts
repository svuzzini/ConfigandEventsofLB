/**
 * Hygiene / best-practice signals.
 *
 * Each rule is pure over (graph, store). Rules never throw on missing fields —
 * absent data means "cannot assert", not "crash". Where a field location is not
 * guaranteed across versions it is marked with an ASSUMPTION comment.
 */
import {
  getBool,
  getString,
  type AviObject,
  type HygieneFinding,
  type HygieneReport,
  type HygieneSeverity,
  type NodeSummary,
} from '@avi/shared';
import type { Store } from '../db/store.js';
import type { RefGraph } from '../graph/ref-graph.js';

const EXPIRY_WARN_DAYS = 30;
const DEFAULT_CERT_NAMES = new Set(['System-Default-Cert', 'System-Default-Cert-EC']);

export async function runHygiene(
  store: Store,
  graph: RefGraph,
  datasetId: string,
): Promise<HygieneReport> {
  const findings: HygieneFinding[] = [];

  // --- Orphans: identified objects nobody references. ---
  for (const node of graph.orphansOfType('Pool')) {
    findings.push(finding('orphaned-pool', 'warning', 'Orphaned pool', node,
      'Pool has no incoming references (no VirtualService, PoolGroup, or policy uses it).'));
  }
  for (const node of graph.orphansOfType('PoolGroup')) {
    findings.push(finding('orphaned-poolgroup', 'warning', 'Orphaned pool group', node,
      'PoolGroup is not referenced by any VirtualService or policy.'));
  }
  for (const node of graph.orphansOfType('HealthMonitor')) {
    findings.push(finding('unused-healthmonitor', 'info', 'Unused health monitor', node,
      'HealthMonitor is not attached to any pool.'));
  }
  for (const node of graph.orphansOfType('SSLKeyAndCertificate')) {
    findings.push(finding('unused-certificate', 'info', 'Unused certificate', node,
      'Certificate is not referenced by any VirtualService or SSL profile.'));
  }

  // --- Disabled virtual services. ---
  await forEachRaw(store, graph, datasetId, 'VirtualService', (node, o) => {
    if (getBool(o, 'enabled') === false) {
      findings.push(finding('disabled-virtualservice', 'info', 'Disabled virtual service', node,
        'VirtualService is administratively disabled (enabled=false).'));
    }
    // ASSUMPTION: a VS "using" a cert exposes it via ssl_key_and_certificate_refs.
    const certRefs = o['ssl_key_and_certificate_refs'];
    if (Array.isArray(certRefs)) {
      for (const ref of certRefs) {
        const name = typeof ref === 'string' ? refFragmentName(ref) : null;
        if (name && DEFAULT_CERT_NAMES.has(name)) {
          findings.push(finding('default-certificate-in-use', 'warning',
            'Default certificate in use', node,
            `VirtualService serves TLS with the built-in "${name}". Replace with a CA-signed certificate.`));
        }
      }
    }
  });

  // --- Certificate expiry. ---
  await forEachRaw(store, graph, datasetId, 'SSLKeyAndCertificate', (node, o) => {
    const notAfter = extractNotAfter(o);
    if (notAfter === null) return;
    const now = Date.now();
    const ms = notAfter.getTime() - now;
    const days = Math.floor(ms / 86_400_000);
    if (ms < 0) {
      findings.push(finding('expired-certificate', 'critical', 'Expired certificate', node,
        `Certificate expired ${Math.abs(days)} day(s) ago (not_after ${notAfter.toISOString()}).`,
        { daysUntilExpiry: days }));
    } else if (days <= EXPIRY_WARN_DAYS) {
      findings.push(finding('expiring-certificate', 'warning', 'Certificate expiring soon', node,
        `Certificate expires in ${days} day(s) (not_after ${notAfter.toISOString()}).`,
        { daysUntilExpiry: days }));
    }
  });

  // --- Dangling references. ---
  for (const edge of graph.danglingEdges()) {
    const subject = graph.getNode(edge.from);
    if (!subject) continue;
    findings.push({
      ruleId: 'dangling-reference',
      severity: 'critical',
      title: 'Dangling reference',
      detail: `Field "${edge.field}" points at ${edge.refName ? `"${edge.refName}"` : 'an object'} that is not present in this export.`,
      subject,
      meta: { field: edge.field, target: edge.refName ?? '(unknown)' },
    });
  }

  return summarize(findings);
}

// ---- helpers ----

function finding(
  ruleId: HygieneFinding['ruleId'],
  severity: HygieneSeverity,
  title: string,
  subject: NodeSummary,
  detail: string,
  meta?: Record<string, string | number | boolean>,
): HygieneFinding {
  return meta ? { ruleId, severity, title, subject, detail, meta } : { ruleId, severity, title, subject, detail };
}

async function forEachRaw(
  store: Store,
  graph: RefGraph,
  datasetId: string,
  type: string,
  fn: (node: NodeSummary, obj: AviObject) => void,
): Promise<void> {
  const nodes = graph.allOfType(type);
  if (nodes.length === 0) return;
  const uuids = nodes.map((n) => n.uuid);
  const raws = await store.getRawMany(datasetId, uuids);
  for (const node of nodes) {
    const raw = raws.get(node.uuid);
    if (!raw) continue;
    try {
      fn(node, JSON.parse(raw) as AviObject);
    } catch {
      /* skip unparseable */
    }
  }
}

/**
 * Extract certificate expiry. ASSUMPTION: SSLKeyAndCertificate carries a nested
 * `certificate` object with a `not_after` string. Avi has used both a space-
 * separated ("2025-12-31 23:59:59") and ISO-8601 form across versions; Date can
 * parse both. Returns null when absent or unparseable.
 */
function extractNotAfter(o: AviObject): Date | null {
  const cert = o['certificate'];
  if (!cert || typeof cert !== 'object') return null;
  const notAfter = (cert as Record<string, unknown>)['not_after'];
  if (typeof notAfter !== 'string') return null;
  const d = new Date(notAfter);
  return Number.isNaN(d.getTime()) ? null : d;
}

function refFragmentName(ref: string): string | null {
  const hash = ref.indexOf('#');
  if (hash !== -1) return decodeURIComponent(ref.slice(hash + 1));
  const nameMatch = ref.match(/[?&]name=([^&]+)/);
  return nameMatch ? decodeURIComponent(nameMatch[1]!) : null;
}

function summarize(findings: HygieneFinding[]): HygieneReport {
  const order: Record<HygieneSeverity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.ruleId.localeCompare(b.ruleId));
  const countsBySeverity: Record<HygieneSeverity, number> = { critical: 0, warning: 0, info: 0 };
  const countsByRule: Record<string, number> = {};
  for (const f of findings) {
    countsBySeverity[f.severity]++;
    countsByRule[f.ruleId] = (countsByRule[f.ruleId] ?? 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    findings,
    countsBySeverity,
    countsByRule,
  };
}
