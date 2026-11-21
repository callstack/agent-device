import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { createLinuxHostStub } from '../toolbox.fixtures.ts';
import { createLinuxToolProvider } from '../tool-provider.ts';
import { captureLinuxSurfaceSnapshot } from '../surface-snapshot.ts';

function node(partial: Partial<RawSnapshotNode> & { index: number }): RawSnapshotNode {
  return { type: 'text', ...partial };
}

test('the Linux surface capture stamps its producer and projects the shape', async () => {
  const stub = createLinuxHostStub({ env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' } });
  const provider = createLinuxToolProvider(stub.toolbox, {
    accessibility: {
      captureTree: async surface => ({
        nodes: [node({ index: 0, label: 'Files', rect: { x: 0, y: 0, width: 10, height: 10 } })],
        truncated: false,
        surface,
      }),
    },
  });

  const result = await captureLinuxSurfaceSnapshot(stub.toolbox, provider, {
    surface: 'desktop',
  });

  assert.equal(result.producer, 'linux-atspi');
  assert.deepEqual(
    (result.nodes ?? []).map(n => n.label),
    ['Files'],
  );
});

test('the Linux surface capture applies the request projection options', async () => {
  const stub = createLinuxHostStub({ env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' } });
  const provider = createLinuxToolProvider(stub.toolbox, {
    accessibility: {
      captureTree: async surface => ({
        nodes: [
          { index: 0, type: 'Group', label: 'desktop', depth: 0 },
          { index: 1, type: 'Button', label: 'Files', depth: 1, parentIndex: 0 },
          { index: 2, type: 'StaticText', label: 'Trash', depth: 3, parentIndex: 1 },
        ],
        truncated: false,
        surface,
      }),
    },
  });

  const result = await captureLinuxSurfaceSnapshot(stub.toolbox, provider, { depth: 1 });

  // The family owns the capture, and still returns the shape the rest of the system projects.
  assert.deepEqual(
    (result.nodes ?? []).map(n => n.label),
    ['desktop', 'Files'],
  );
});
