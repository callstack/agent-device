import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { assertInstalledSnapshotBridge, measureDirectory } from '../size-report-install.mjs';

test('measures the clean-installed package tree without counting the consumer', async () => {
  const root = await mkdtempForTest('agent-device-size-tree-');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'index.js'), '1234');
  await writeFile(join(root, 'nested', 'data.json'), '{}');
  assert.deepEqual(measureDirectory(root), { packageBytes: 6, files: 2 });
});

test('clean-installed snapshot bridge validates all native assets when present', async () => {
  const root = await mkdtempForTest('agent-device-size-bridge-');
  const bridge = join(root, 'apple', 'snapshot-bridge');
  try {
    assert.doesNotThrow(() => assertInstalledSnapshotBridge(root));
    await mkdir(bridge, { recursive: true });
    await writeFile(join(bridge, 'SnapshotBridge.m'), 'native source');
    await writeFile(join(bridge, 'SnapshotBridgeRuntime.m'), 'native runtime');
    await writeFile(join(bridge, 'SnapshotBridgeRuntime.h'), 'native header');
    assert.doesNotThrow(() => assertInstalledSnapshotBridge(root));
    await rm(join(bridge, 'SnapshotBridgeRuntime.h'));
    assert.throws(() => assertInstalledSnapshotBridge(root), /SnapshotBridgeRuntime\.h/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
