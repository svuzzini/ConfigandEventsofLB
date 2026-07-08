import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRef, uuidVariants } from '@avi/shared';
import { RefGraph } from './ref-graph.js';

test('parseRef extracts type, uuid, and fragment name', () => {
  const r = parseRef('https://10.0.0.1/api/pool/pool-84cf-e6b#web-pool');
  assert.equal(r?.objectType, 'pool');
  assert.equal(r?.uuid, 'pool-84cf-e6b');
  assert.equal(r?.name, 'web-pool');
});

test('parseRef reads ?name=&tenant=&cloud= query params', () => {
  const r = parseRef('https://c/api/vsvip/vsvip-1?name=my-vip&tenant=admin&cloud=Default-Cloud');
  assert.equal(r?.name, 'my-vip');
  assert.equal(r?.tenant, 'admin');
  assert.equal(r?.cloud, 'Default-Cloud');
});

test('parseRef tolerates bare names', () => {
  assert.equal(parseRef('admin')?.name, 'admin');
  assert.equal(parseRef(''), null);
  assert.equal(parseRef(42 as unknown), null);
});

test('uuidVariants strips the type prefix', () => {
  assert.deepEqual(uuidVariants('pool-84cf-e6b'), ['pool-84cf-e6b', '84cf-e6b']);
});

test('graph resolves VS -> pool by uuid', () => {
  const g = new RefGraph();
  g.addObject('VirtualService', {
    name: 'vs1', uuid: 'virtualservice-1',
    pool_ref: 'https://c/api/pool/pool-1#web-pool',
    tenant_ref: 'https://c/api/tenant/tenant-a#admin',
  });
  g.addObject('Pool', { name: 'web-pool', uuid: 'pool-1' });
  g.resolve();

  const out = g.outgoingOf('virtualservice-1');
  const poolEdge = out.find((e) => e.field === 'pool_ref');
  assert.equal(poolEdge?.to, 'pool-1');
  assert.equal(poolEdge?.resolvedBy, 'uuid');
  assert.equal(g.incomingOf('pool-1').length, 1);
});

test('graph falls back to type+name when uuid does not match', () => {
  const g = new RefGraph();
  // ref points at a bare uuid the target does not carry, but names match.
  g.addObject('VirtualService', {
    name: 'vs2', uuid: 'virtualservice-2',
    pool_ref: 'https://c/api/pool/pool-DIFFERENT#web-pool',
  });
  g.addObject('Pool', { name: 'web-pool', uuid: 'pool-actual' });
  g.resolve();
  const edge = g.outgoingOf('virtualservice-2')[0];
  assert.equal(edge?.to, 'pool-actual');
  assert.equal(edge?.resolvedBy, 'name');
});

test('graph flags dangling references', () => {
  const g = new RefGraph();
  g.addObject('VirtualService', {
    name: 'vs3', uuid: 'virtualservice-3',
    pool_ref: 'https://c/api/pool/pool-missing#ghost',
  });
  g.resolve();
  assert.equal(g.dangling, 1);
  assert.equal(g.danglingEdges()[0]?.refName, 'ghost');
});

test('graph collects nested refs (poolgroup members)', () => {
  const g = new RefGraph();
  g.addObject('PoolGroup', {
    name: 'pg1', uuid: 'poolgroup-1',
    members: [
      { pool_ref: 'https://c/api/pool/pool-1#p1', ratio: 100 },
      { pool_ref: 'https://c/api/pool/pool-2#p2', ratio: 50 },
    ],
  });
  g.addObject('Pool', { name: 'p1', uuid: 'pool-1' });
  g.addObject('Pool', { name: 'p2', uuid: 'pool-2' });
  g.resolve();
  const targets = g.outgoingOf('poolgroup-1').map((e) => e.to).sort();
  assert.deepEqual(targets, ['pool-1', 'pool-2']);
});

test('dependency graph walks VS -> vsvip/pool chain with depth', () => {
  const g = new RefGraph();
  g.addObject('VirtualService', {
    name: 'vs', uuid: 'virtualservice-9',
    vsvip_ref: 'https://c/api/vsvip/vsvip-9#vip',
    pool_ref: 'https://c/api/pool/pool-9#pool',
  });
  g.addObject('VsVip', { name: 'vip', uuid: 'vsvip-9' });
  g.addObject('Pool', {
    name: 'pool', uuid: 'pool-9',
    health_monitor_refs: ['https://c/api/healthmonitor/healthmonitor-9#hm'],
  });
  g.addObject('HealthMonitor', { name: 'hm', uuid: 'healthmonitor-9' });
  g.resolve();

  const dep = g.dependencyGraph('virtualservice-9');
  assert.ok(dep);
  const uuids = dep!.nodes.map((n) => n.uuid).sort();
  assert.deepEqual(uuids, ['healthmonitor-9', 'pool-9', 'virtualservice-9', 'vsvip-9']);
  const hm = dep!.nodes.find((n) => n.uuid === 'healthmonitor-9');
  assert.equal(hm?.depth, 2);
});
