import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../extract-app.mjs';

const { ConfigScanner, scanBlob } = app;

/** Run the scanner over `text` split into chunks of `size` characters. */
function scan(text, size = text.length) {
  const seen = {};
  const objects = [];
  const meta = {};
  const s = new ConfigScanner({
    onObject: (type, obj, slice) => {
      seen[type] = (seen[type] ?? 0) + 1;
      objects.push({ type, obj, slice });
    },
    onMeta: (k, v) => { meta[k] = v; },
  });
  for (let i = 0; i < text.length; i += size) s.feed(text.slice(i, i + size));
  s.end();
  return { seen, objects, meta };
}

const DUMP = JSON.stringify({
  META: { version: { Version: '22.1.3', build: 9099 }, cluster_uuid: 'cluster-abc' },
  VirtualService: [
    { name: 'vs1', uuid: 'virtualservice-1', enabled: true },
    { name: 'vs2', uuid: 'virtualservice-2', enabled: false },
  ],
  Pool: [
    { name: 'p1', uuid: 'pool-1' },
    42, // non-object element must be tolerated (skipped: it carries no identity)
    { name: 'p2', uuid: 'pool-2', servers: [{ ip: { addr: '1.2.3.4' } }] },
  ],
  EmptyType: [],
});

test('scanner emits objects per type and captures META', () => {
  const { seen, meta } = scan(DUMP);
  assert.equal(seen.VirtualService, 2);
  // Intentional change vs the old stream-json pipeline: scalar array elements
  // are skipped at the scanner (they were emitted then discarded downstream).
  assert.equal(seen.Pool, 2);
  assert.equal(seen.EmptyType, undefined);
  assert.equal(meta.META.cluster_uuid, 'cluster-abc');
  assert.equal(meta.META.version.Version, '22.1.3');
});

test('scanner is chunk-boundary independent (1-char chunks)', () => {
  const whole = scan(DUMP);
  const tiny = scan(DUMP, 1);
  const mid = scan(DUMP, 7);
  assert.deepEqual(tiny.seen, whole.seen);
  assert.deepEqual(mid.seen, whole.seen);
  assert.deepEqual(tiny.meta, whole.meta);
  assert.deepEqual(tiny.objects.map((o) => o.obj), whole.objects.map((o) => o.obj));
});

test('scanner handles deeply nested objects and keeps the exact raw slice', () => {
  const dump = JSON.stringify({
    HTTPPolicySet: [
      {
        name: 'pol', uuid: 'httppolicyset-1',
        http_request_policy: {
          rules: [{ name: 'r1', switching_action: { pool_ref: 'https://c/api/pool/pool-1#p1' } }],
        },
      },
    ],
  });
  const { objects } = scan(dump, 3);
  assert.equal(objects.length, 1);
  assert.equal(
    objects[0].obj.http_request_policy.rules[0].switching_action.pool_ref,
    'https://c/api/pool/pool-1#p1',
  );
  // The slice must round-trip to the identical object.
  assert.deepEqual(JSON.parse(objects[0].slice), objects[0].obj);
});

test('scanner survives strings full of brackets, escapes, and unicode keys', () => {
  const dump = JSON.stringify({
    Pool: [
      { name: 'tricky "quoted" \\ {a}[b]', uuid: 'pool-tricky', desc: '}{][""\\"' },
    ],
    'wéird key': { note: 'meta with unicode key' },
  });
  for (const size of [1, 5, 1024]) {
    const { seen, meta, objects } = scan(dump, size);
    assert.equal(seen.Pool, 1, 'chunk size ' + size);
    assert.equal(objects[0].obj.name, 'tricky "quoted" \\ {a}[b]');
    assert.equal(meta['wéird key'].note, 'meta with unicode key');
  }
});

test('scanner tolerates top-level scalar values without desyncing keys', () => {
  const dump = '{"some_count": 42, "flag": true, "label": "x", "Pool": [{"name": "p", "uuid": "pool-p"}]}';
  const { seen } = scan(dump, 4);
  assert.equal(seen.Pool, 1);
});

test('scanner rejects non-object roots with a plain-language error', () => {
  assert.throws(() => scan('[1,2,3]'), /JSON array/);
  assert.throws(() => scan('not json at all'), /JSON object/);
  assert.throws(() => scan('{"Pool": [{"name": "p"'), /unexpected end/);
});

test('scanBlob streams a Blob and reports progress', async () => {
  const blob = new Blob([DUMP]);
  const seen = {};
  let progressCalls = 0;
  await scanBlob(blob, {
    onObject: (type) => { seen[type] = (seen[type] ?? 0) + 1; },
  }, () => { progressCalls++; });
  assert.equal(seen.VirtualService, 2);
  assert.equal(seen.Pool, 2);
  assert.ok(progressCalls >= 1);
});
