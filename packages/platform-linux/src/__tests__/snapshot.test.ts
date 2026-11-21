import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { createLinuxHostStub } from '../toolbox.fixtures.ts';
import { createLinuxToolProvider } from '../tool-provider.ts';
import { readLinuxTextAtPoint, snapshotLinux } from '../snapshot.ts';

function node(partial: Partial<RawSnapshotNode> & { index: number }): RawSnapshotNode {
  return { type: 'text', ...partial };
}

/**
 * The capture route under test: the AT-SPI answer is stated by the test, so a test about which
 * surface was captured, or about what the hit-test returned, needs neither Python nor a registry.
 */
function host(
  nodes: readonly RawSnapshotNode[],
  answer: Readonly<{ truncated?: boolean }> = {},
): Readonly<{
  stub: ReturnType<typeof createLinuxHostStub>;
  provider: ReturnType<typeof createLinuxToolProvider>;
  captures: Array<[string, unknown]>;
}> {
  const captures: Array<[string, unknown]> = [];
  const stub = createLinuxHostStub({ env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' } });
  const provider = createLinuxToolProvider(stub.toolbox, {
    accessibility: {
      captureTree: async (surface, options) => {
        captures.push([surface, { signal: options?.signal }]);
        return { nodes, truncated: answer.truncated ?? false, surface };
      },
    },
  });
  return { stub, provider, captures };
}

test('snapshotLinux maps the app surface to the frontmost app and forwards the signal', async () => {
  const signal = new AbortController().signal;
  const { stub, provider, captures } = host([]);

  await snapshotLinux(stub.toolbox, provider, 'app', signal);

  assert.deepEqual(captures, [['frontmost-app', { signal }]]);
});

test('snapshotLinux falls back to desktop for the unsupported menubar surface', async () => {
  const { stub, provider, captures } = host([]);

  await snapshotLinux(stub.toolbox, provider, 'menubar');

  assert.deepEqual(
    captures.map(([surface]) => surface),
    ['desktop'],
  );
  // The fallback is reported through the host, so `--debug` says why the capture is the whole desktop.
  assert.deepEqual(stub.diagnostics, [
    {
      level: 'warn',
      phase: 'linux_snapshot',
      data: { message: 'menubar surface is not supported on Linux, falling back to desktop' },
    },
  ]);
});

test('snapshotLinux keeps the capture bounds the AT-SPI helper reported', async () => {
  const nodes = [node({ index: 0, label: 'window' })];
  const { stub, provider } = host(nodes, { truncated: true });

  const result = await snapshotLinux(stub.toolbox, provider, 'desktop');

  assert.deepEqual(result, { nodes, truncated: true });
});

test('readLinuxTextAtPoint prefers the deepest match and the smaller area at equal depth', async () => {
  const { stub, provider } = host([
    node({ index: 0, depth: 0, label: 'window', rect: { x: 0, y: 0, width: 800, height: 600 } }),
    node({ index: 1, depth: 3, label: 'button', rect: { x: 10, y: 10, width: 200, height: 100 } }),
    node({ index: 2, depth: 3, label: 'icon', rect: { x: 50, y: 50, width: 20, height: 20 } }),
  ]);

  const text = await readLinuxTextAtPoint(stub.toolbox, provider, 55, 55, 'desktop');

  assert.equal(text, 'icon');
});

test('readLinuxTextAtPoint reads the value before the label', async () => {
  const { stub, provider } = host([
    node({
      index: 0,
      depth: 0,
      value: 'typed text',
      label: 'field label',
      rect: { x: 0, y: 0, width: 100, height: 100 },
    }),
  ]);

  assert.equal(await readLinuxTextAtPoint(stub.toolbox, provider, 5, 5, 'desktop'), 'typed text');
});

test('readLinuxTextAtPoint answers the empty string when nothing covers the point', async () => {
  const { stub, provider } = host([
    node({ index: 0, depth: 0, label: 'window', rect: { x: 0, y: 0, width: 10, height: 10 } }),
  ]);

  assert.equal(await readLinuxTextAtPoint(stub.toolbox, provider, 500, 500, 'desktop'), '');
});
