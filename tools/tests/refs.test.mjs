import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../extract-app.mjs';

const { parseRef, uuidVariants, refName } = app;

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
  assert.equal(parseRef(42), null);
});

test('uuidVariants strips the type prefix', () => {
  assert.deepEqual(uuidVariants('pool-84cf-e6b'), ['pool-84cf-e6b', '84cf-e6b']);
});

test('refName falls back name -> uuid -> raw', () => {
  assert.equal(refName('https://c/api/pool/pool-1#p1'), 'p1');
  assert.equal(refName('https://c/api/pool/pool-1'), 'pool-1');
  assert.equal(refName('admin'), 'admin');
  assert.equal(refName(null), '');
});
