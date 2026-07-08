import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamAviConfig } from './stream-parse.js';

test('streamAviConfig emits objects per type and captures META', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avi-'));
  const path = join(dir, 'cfg.json');
  const dump = {
    META: { version: { Version: '22.1.3', build: 9099 }, cluster_uuid: 'cluster-abc' },
    VirtualService: [
      { name: 'vs1', uuid: 'virtualservice-1', enabled: true },
      { name: 'vs2', uuid: 'virtualservice-2', enabled: false },
    ],
    Pool: [
      { name: 'p1', uuid: 'pool-1' },
      42, // non-object element must be tolerated
      { name: 'p2', uuid: 'pool-2', servers: [{ ip: { addr: '1.2.3.4' } }] },
    ],
    EmptyType: [],
  };
  await writeFile(path, JSON.stringify(dump));

  const seen: Record<string, number> = {};
  const meta: Record<string, unknown> = {};
  await streamAviConfig(path, {
    onObject: (type) => {
      seen[type] = (seen[type] ?? 0) + 1;
    },
    onMeta: (k, v) => {
      meta[k] = v;
    },
  });

  assert.equal(seen['VirtualService'], 2);
  assert.equal(seen['Pool'], 3); // includes the scalar element
  assert.equal(seen['EmptyType'], undefined);
  assert.deepEqual((meta['META'] as { cluster_uuid: string }).cluster_uuid, 'cluster-abc');

  await rm(dir, { recursive: true, force: true });
});

test('streamAviConfig handles deeply nested objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avi-'));
  const path = join(dir, 'cfg.json');
  const dump = {
    HTTPPolicySet: [
      {
        name: 'pol', uuid: 'httppolicyset-1',
        http_request_policy: {
          rules: [{ name: 'r1', switching_action: { pool_ref: 'https://c/api/pool/pool-1#p1' } }],
        },
      },
    ],
  };
  await writeFile(path, JSON.stringify(dump));

  const objects: unknown[] = [];
  await streamAviConfig(path, {
    onObject: (_t, o) => {
      objects.push(o);
    },
  });
  assert.equal(objects.length, 1);
  const obj = objects[0] as { http_request_policy: { rules: { switching_action: { pool_ref: string } }[] } };
  assert.equal(obj.http_request_policy.rules[0]!.switching_action.pool_ref, 'https://c/api/pool/pool-1#p1');

  await rm(dir, { recursive: true, force: true });
});
