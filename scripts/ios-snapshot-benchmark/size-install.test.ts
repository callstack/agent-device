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

test('clean-installed snapshot bridge keeps both native prepare/acquire sources', async () => {
  const root = await mkdtempForTest('agent-device-size-bridge-');
  const bridge = join(root, 'apple', 'snapshot-bridge');
  await mkdir(bridge, { recursive: true });
  await writeFile(join(bridge, 'SnapshotBridge.m'), 'serve');
  await writeFile(join(bridge, 'SnapshotBridgeRuntime.m'), 'snapshotForProcess');
  try {
    assert.doesNotThrow(() => assertInstalledSnapshotBridge(root));
    await rm(join(bridge, 'SnapshotBridgeRuntime.m'));
    assert.throws(() => assertInstalledSnapshotBridge(root), /SnapshotBridgeRuntime\.m/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
