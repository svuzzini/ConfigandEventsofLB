import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { app } from '../extract-app.mjs';

const {
  ingestBlob, searchDataset, searchSnippets, tokenizeQuery,
  MAX_SEARCH_RESULTS, MIN_SEARCH_LENGTH,
} = app;

const sampleText = readFileSync(new URL('../../examples/sample_avi_config.json', import.meta.url), 'utf8');

async function loadSample() {
  return ingestBlob(new Blob([sampleText]), 'sample_avi_config.json');
}

/** Four pools sharing/differing in server IP and port — the AND-query fixture. */
async function loadPools() {
  const cfg = {
    Pool: [
      { name: 'p1', uuid: 'pool-1', servers: [{ ip: { addr: '10.0.0.5' }, port: 8080 }] },
      { name: 'p2', uuid: 'pool-2', servers: [{ ip: { addr: '10.0.0.5' }, port: 8080 }] },
      { name: 'p3', uuid: 'pool-3', servers: [{ ip: { addr: '10.0.0.5' }, port: 9090 }] },
      { name: 'p4', uuid: 'pool-4', servers: [{ ip: { addr: '10.9.9.9' }, port: 8080 }] },
    ],
  };
  return ingestBlob(new Blob([JSON.stringify(cfg)]), 'pools.json');
}

test('searching an IP address finds every object that carries it', async () => {
  const ds = await loadSample();
  const res = await searchDataset(ds, '10.0.1.11');
  assert.ok(res.total >= 1, 'at least one object matches');
  assert.equal(res.results.length, res.total, 'under the cap, all matches are retained');
  assert.ok(res.results.some((r) => r.node.type === 'Pool'), 'the pool holding that server is found');
  const withSnippet = res.results.find((r) => r.snippets.length > 0);
  assert.ok(withSnippet, 'content matches carry snippets');
  assert.equal(withSnippet.snippets[0].match, '10.0.1.11');
});

test('multi-term queries AND terms: server + port across pools', async () => {
  const ds = await loadPools();
  const res = await searchDataset(ds, '10.0.0.5 8080');
  assert.equal(res.total, 2, 'only pools with BOTH the server and the port');
  assert.deepEqual(res.results.map((r) => r.node.name).sort(), ['p1', 'p2']);
});

test('punctuation in the query is forgiven: ip:port ≡ ip port', async () => {
  const ds = await loadPools();
  const colon = await searchDataset(ds, '10.0.0.5:8080');
  assert.equal(colon.total, 2);
  const pastedJson = await searchDataset(ds, '"addr": 10.0.0.5');
  assert.equal(pastedJson.total, 3, 'quotes/colons are separators, not literals');
});

test('tokenizeQuery keeps IPs, uuids, and field names whole', () => {
  assert.deepEqual(tokenizeQuery('10.0.1.11:8080'), ['10.0.1.11', '8080']);
  assert.deepEqual(tokenizeQuery('"pool_ref": web-pool'), ['pool_ref', 'web-pool']);
  assert.deepEqual(tokenizeQuery('  '), []);
});

test('search is case-insensitive and ranks name matches first', async () => {
  const ds = await loadSample();
  const res = await searchDataset(ds, 'UNUSED-PING');
  assert.ok(res.total >= 1);
  assert.equal(res.results[0].node.name, 'unused-ping', 'name match ranks first');
});

test('searching a type name matches objects of that type', async () => {
  const ds = await loadSample();
  const res = await searchDataset(ds, 'VsVip');
  assert.ok(res.results.some((r) => r.node.type === 'VsVip'));
});

test('byType facets count all candidates; typeFilter narrows results only', async () => {
  const ds = await loadSample();
  const res = await searchDataset(ds, 'web-vip');
  const facets = new Map(res.byType.map((b) => [b.key, b.count]));
  assert.equal(facets.get('VsVip'), 1, 'the vip itself');
  assert.equal(facets.get('VirtualService'), 3, 'every VS referencing it');

  const filtered = await searchDataset(ds, 'web-vip', { typeFilter: 'VirtualService' });
  assert.equal(filtered.total, 3);
  assert.ok(filtered.results.every((r) => r.node.type === 'VirtualService'));
  const filteredFacets = new Map(filtered.byType.map((b) => [b.key, b.count]));
  assert.equal(filteredFacets.get('VsVip'), 1, 'facets still describe the unfiltered set');
});

test('the index is built once per dataset and reused', async () => {
  const ds = await loadSample();
  const first = ds.searchIndex();
  const second = ds.searchIndex();
  assert.equal(first, second, 'same cached build promise');
  await searchDataset(ds, 'web-pool');
  assert.equal(ds.searchIndex(), first, 'searchDataset reuses it too');
});

test('queries below the minimum length return an empty result', async () => {
  const ds = await loadSample();
  const res = await searchDataset(ds, 'a');
  assert.equal(res.total, 0);
  assert.equal(res.results.length, 0);
  assert.ok(MIN_SEARCH_LENGTH > 1);
});

test('results are capped at MAX_SEARCH_RESULTS but the total stays exact', async () => {
  const vs = [];
  for (let i = 0; i < 600; i++) {
    vs.push({ name: 'vs' + i, uuid: 'virtualservice-' + i, description: 'listens on 10.9.9.9' });
  }
  const ds = await ingestBlob(new Blob([JSON.stringify({ VirtualService: vs })]), 'x.json');
  const res = await searchDataset(ds, '10.9.9.9');
  assert.equal(res.total, 600);
  assert.equal(res.results.length, MAX_SEARCH_RESULTS);
  assert.equal(res.truncated, true);
});

test('isCancelled aborts a search at a yield point', async () => {
  const vs = [];
  for (let i = 0; i < 2500; i++) vs.push({ name: 'vs' + i, uuid: 'virtualservice-' + i });
  const ds = await ingestBlob(new Blob([JSON.stringify({ VirtualService: vs })]), 'x.json');
  let calls = 0;
  const res = await searchDataset(ds, 'vs1', { isCancelled: () => ++calls > 0 });
  assert.equal(res.cancelled, true);
  assert.equal(res.results.length, 0, 'a cancelled search returns no results');
  const again = await searchDataset(ds, 'vs1');
  assert.ok(again.total > 0, 'the shared index survives a cancelled search');
});

test('searchSnippets extracts the nearest field and bounded context', () => {
  const raw = '{"name":"web-pool","servers":[{"ip":{"addr":"10.0.1.11","type":"V4"}}]}';
  const snips = searchSnippets(raw, '10.0.1.11');
  assert.equal(snips.length, 1);
  assert.equal(snips[0].field, 'addr');
  assert.equal(snips[0].match, '10.0.1.11');

  // Case-insensitive: match preserves the raw slice's casing.
  const upper = searchSnippets('{"fqdn":"App.Example.COM"}', 'app.example.com');
  assert.equal(upper.length, 1);
  assert.equal(upper[0].match, 'App.Example.COM');

  // Snippet count is capped.
  const many = '{"a":"xx","b":"xx","c":"xx","d":"xx","e":"xx"}';
  assert.ok(searchSnippets(many, 'xx').length <= 3);
});

test('multi-term results carry a snippet per term', async () => {
  const ds = await loadPools();
  const res = await searchDataset(ds, '10.0.0.5 8080');
  const r = res.results[0];
  const matched = r.snippets.map((s) => s.match);
  assert.ok(matched.includes('10.0.0.5'), 'snippet for the IP term');
  assert.ok(matched.includes('8080'), 'snippet for the port term');
});
