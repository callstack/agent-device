import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';

const { runHarmonyHdc } = vi.hoisted(() => ({ runHarmonyHdc: vi.fn() }));

vi.mock('../hdc.ts', () => ({ runHarmonyHdc }));

import { parseArkUiBounds, parseHarmonyLayout, snapshotHarmony } from '../snapshot.ts';

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

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

test('snapshotHarmony reports truncation once the node cap is hit instead of dropping nodes silently', async () => {
  scriptHarmonyLayoutDump({
    attributes: { type: 'root', bounds: '[0,0][1080,2340]' },
    children: [
      { attributes: { type: 'Button', text: 'first', clickable: 'true' } },
      { attributes: { type: 'Button', text: 'second', clickable: 'true' } },
      { attributes: { type: 'Button', text: 'third', clickable: 'true' } },
    ],
  });

  const capped = await snapshotHarmony(DEVICE, { maxNodes: 2 });

  assert.equal(capped.truncated, true);
  assert.deepEqual(
    capped.nodes.map((node) => node.value ?? node.type),
    ['Application', 'first'],
  );
  assert.equal(capped.analysis.rawNodeCount, 4);

  const uncapped = await snapshotHarmony(DEVICE);
  assert.equal(uncapped.truncated, undefined);
  assert.equal(uncapped.nodes.length, 4);
});

test('snapshotHarmony keeps counting the tree below a node the cap omitted', async () => {
  // The cap fills on `first`, so `branch` and everything under it is omitted.
  // `analysis` still describes the tree the device reported, so the omitted
  // subtree must reach both counters — five nodes, deepest at depth 3.
  scriptHarmonyLayoutDump({
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
  });

  const capped = await snapshotHarmony(DEVICE, { maxNodes: 2 });

  assert.equal(capped.truncated, true);
  assert.deepEqual(
    capped.nodes.map((node) => node.value ?? node.type),
    ['Application', 'first'],
  );
  assert.deepEqual(capped.analysis, { rawNodeCount: 5, maxDepth: 3 });
});
