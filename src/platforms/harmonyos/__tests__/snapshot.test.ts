import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';

const { runHarmonyHdc } = vi.hoisted(() => ({ runHarmonyHdc: vi.fn() }));

vi.mock('../hdc.ts', () => ({ runHarmonyHdc }));

import {
  collectArkUiNodes,
  parseArkUiBounds,
  parseHarmonyLayout,
  snapshotHarmony,
} from '../snapshot.ts';

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

const UNBOUNDED = { maxDepth: Number.POSITIVE_INFINITY, interactiveOnly: false };

beforeEach(() => {
  runHarmonyHdc.mockReset();
});

/** Scripts `uitest dumpLayout` + `file recv` so the pulled layout is `layout`. */
function scriptHarmonyLayoutDump(layout: unknown): void {
  runHarmonyHdc.mockImplementation(async (_device: unknown, args: string[]) => {
    if (args[0] === 'file' && args[1] === 'recv') {
      fs.writeFileSync(args[3] as string, JSON.stringify(layout), 'utf8');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

test('parseArkUiBounds converts API 24 layout bounds into a rectangle', () => {
  assert.deepEqual(parseArkUiBounds('[84,1127][1172,1295]'), {
    x: 84,
    y: 1127,
    width: 1088,
    height: 168,
  });
  assert.equal(parseArkUiBounds('[84,1127][not-a-coordinate,1295]'), undefined);
});

test('parseHarmonyLayout rejects non-object uitest documents', () => {
  assert.throws(() => parseHarmonyLayout('[]'), /invalid layout JSON/i);
});

test('collectArkUiNodes reports truncation once the emitted-node limit is reached', () => {
  const root = parseHarmonyLayout(
    JSON.stringify({
      attributes: { type: 'root', bounds: '[0,0][1080,2340]' },
      children: [
        { attributes: { type: 'Button', text: 'first', clickable: 'true' } },
        { attributes: { type: 'Button', text: 'second', clickable: 'true' } },
        { attributes: { type: 'Button', text: 'third', clickable: 'true' } },
      ],
    }),
  );

  const capped = collectArkUiNodes(root, { ...UNBOUNDED, maxNodes: 2 });
  assert.equal(capped.truncated, true);
  assert.deepEqual(
    capped.nodes.map((node) => node.value ?? node.type),
    ['Application', 'first'],
  );
  assert.deepEqual(capped.analysis, { rawNodeCount: 4, maxDepth: 1 });

  const uncapped = collectArkUiNodes(root, { ...UNBOUNDED, maxNodes: 5_000 });
  assert.equal(uncapped.truncated, false);
  assert.equal(uncapped.nodes.length, 4);
});

test('collectArkUiNodes keeps counting the tree below a node the limit omitted', () => {
  // The limit fills on `first`, so `branch` and everything under it is
  // omitted. `analysis` still describes the tree the device reported, so the
  // omitted subtree must reach both counters: five nodes, deepest at depth 3.
  const root = parseHarmonyLayout(
    JSON.stringify({
      attributes: { type: 'root', bounds: '[0,0][1080,2340]' },
      children: [
        { attributes: { type: 'Button', text: 'first', clickable: 'true' } },
        {
          attributes: { type: 'Column', text: 'branch' },
          children: [
            {
              attributes: { type: 'Row', text: 'leaf' },
              children: [{ attributes: { type: 'Text', text: 'deep' } }],
            },
          ],
        },
      ],
    }),
  );

  const capped = collectArkUiNodes(root, { ...UNBOUNDED, maxNodes: 2 });

  assert.equal(capped.truncated, true);
  assert.deepEqual(
    capped.nodes.map((node) => node.value ?? node.type),
    ['Application', 'first'],
  );
  assert.deepEqual(capped.analysis, { rawNodeCount: 5, maxDepth: 3 });
});

test('snapshotHarmony pulls a uitest layout and reports its analysis', async () => {
  scriptHarmonyLayoutDump({
    attributes: { type: 'root', bounds: '[0,0][1080,2340]' },
    children: [{ attributes: { type: 'Button', text: 'first', clickable: 'true' } }],
  });

  const snapshot = await snapshotHarmony(DEVICE);

  assert.equal(snapshot.truncated, undefined);
  assert.deepEqual(
    snapshot.nodes.map((node) => node.value ?? node.type),
    ['Application', 'first'],
  );
  assert.deepEqual(snapshot.analysis, { rawNodeCount: 2, maxDepth: 1 });
});
