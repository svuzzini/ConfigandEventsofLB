import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { app } from '../extract-app.mjs';

const { ingestBlob, MAX_EXEMPLARS } = app;

const sampleText = readFileSync(new URL('../../examples/sample_avi_config.json', import.meta.url), 'utf8');

async function loadSample() {
  return ingestBlob(new Blob([sampleText]), 'sample_avi_config.json');
}

test('end-to-end: sample export ingests with a resolved graph', async () => {
  const ds = await loadSample();
  assert.ok(ds.objectCount > 10, 'objects ingested');
  assert.equal(ds.raws.size, ds.graph.size, 'one raw slice per graph node');
  assert.ok(ds.graph.edges > 0, 'edges resolved');
  assert.equal(ds.version(), '22.1.3');

  const inv = ds.inventory();
  assert.equal(inv.total, ds.objectCount);
  const vsBucket = inv.byType.find((b) => b.key === 'VirtualService');
  assert.ok(vsBucket && vsBucket.count > 0);

  // Raw slices must round-trip: unknown fields flow through untouched.
  const anyVs = ds.graph.allOfType('VirtualService')[0];
  const obj = ds.getObj(anyVs.uuid);
  assert.equal(obj.uuid, anyVs.uuid);
});

test('end-to-end: hygiene finds the sample’s known issues', async () => {
  const ds = await loadSample();
  const report = ds.hygiene();
  const byRule = new Map(report.rules.map((r) => [r.ruleId, r]));

  // The sample contains a cert with not_after in 2021 -> expired.
  assert.ok((byRule.get('expired-certificate')?.count ?? 0) >= 1, 'expired cert found');
  // The sample has an unused ping health monitor.
  const unusedHm = byRule.get('unused-healthmonitor');
  assert.ok(unusedHm && unusedHm.findings.some((f) => f.subject.name === 'unused-ping'));

  // Counts are exact and exemplars are capped.
  for (const r of report.rules) {
    assert.ok(r.findings.length <= MAX_EXEMPLARS);
    assert.ok(r.count >= r.findings.length);
  }
  const sevSum = report.countsBySeverity.critical + report.countsBySeverity.warning + report.countsBySeverity.info;
  assert.equal(sevSum, report.total);
});

test('hygiene caps exemplars but keeps exact counts on pathological input', async () => {
  // 600 VSes, each with one dangling pool ref -> 600 dangling findings, capped at MAX_EXEMPLARS.
  const vs = [];
  for (let i = 0; i < 600; i++) {
    vs.push({ name: 'vs' + i, uuid: 'virtualservice-' + i, pool_ref: 'https://c/api/pool/pool-ghost-' + i + '#ghost' + i });
  }
  const ds = await ingestBlob(new Blob([JSON.stringify({ VirtualService: vs })]), 'x.json');
  const report = ds.hygiene();
  const dangling = report.rules.find((r) => r.ruleId === 'dangling-reference');
  assert.equal(dangling.count, 600);
  assert.equal(dangling.findings.length, MAX_EXEMPLARS);
  assert.equal(report.countsBySeverity.critical, 600);
});

test('columnsFor picks informative scalar columns', async () => {
  const ds = await loadSample();
  const cols = ds.columnsFor('VirtualService');
  assert.ok(cols.length > 0 && cols.length <= 4);
  assert.ok(!cols.includes('uuid') && !cols.includes('name'), 'base fields excluded');
});

test('columnValues builds a sortable value map', async () => {
  const ds = await loadSample();
  const values = await ds.columnValues('VirtualService', 'enabled');
  assert.equal(values.size, ds.graph.allOfType('VirtualService').length);
});
