import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import {
  assertInstalledSnapshotBridge,
  measureCleanInstalledPackage,
  measureDirectory,
} from '../size-report-install.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

test('clean install includes hoisted, scoped, and nested dependencies but excludes consumer and cache files', () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    const argv = args as string[];
    const consumer = argv[argv.indexOf('--prefix') + 1]!;
    const files = {
      'node_modules/agent-device/index.js': '1234',
      'node_modules/agent-device/node_modules/nested/index.js': '123',
      'node_modules/hoisted/index.js': '123456',
      'node_modules/@scope/dependency/index.js': '12345',
      'package.json': 'consumer metadata',
      '../npm-cache/download': 'cached tarball',
    };
    for (const [relative, content] of Object.entries(files)) {
      const file = join(consumer, relative);
      fs.mkdirSync(join(file, '..'), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return '';
  });

  assert.deepEqual(measureCleanInstalledPackage('fixture.tgz', 'agent-device'), {
    packageBytes: 7,
    files: 2,
    totalBytes: 18,
  });
});

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
    await writeFile(join(bridge, 'SnapshotBridgeCapture.h'), 'capture header');
    await writeFile(join(bridge, 'SnapshotBridgeCapture.m'), 'capture source');
    await writeFile(join(bridge, 'ForegroundApplicationGeometry.h'), 'shared rule');
    assert.doesNotThrow(() => assertInstalledSnapshotBridge(root));
    await rm(join(bridge, 'SnapshotBridgeRuntime.h'));
    assert.throws(() => assertInstalledSnapshotBridge(root), /SnapshotBridgeRuntime\.h/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clean-installed package requires the shared header mirror only when the runner includes it', async () => {
  const root = await mkdtempForTest('agent-device-size-header-');
  const bridge = join(root, 'apple', 'snapshot-bridge');
  const runner = join(
    root,
    'dist',
    'apple',
    'runner',
    'AgentDeviceRunner',
    'AgentDeviceRunnerUITests',
  );
  const bridgeNames = [
    'SnapshotBridge.m',
    'SnapshotBridgeRuntime.m',
    'SnapshotBridgeRuntime.h',
    'SnapshotBridgeCapture.h',
    'SnapshotBridgeCapture.m',
    'ForegroundApplicationGeometry.h',
  ];
  const writeBridge = async () => {
    await mkdir(bridge, { recursive: true });
    for (const name of bridgeNames) {
      await writeFile(join(bridge, name), 'native source');
    }
  };
  try {
    await writeBridge();
    await mkdir(runner, { recursive: true });
    // A packaged runner whose sources never include the shared header is a legacy package: the
    // mirror is nobody's include target, so nothing is required.
    await writeFile(join(runner, 'RunnerXCTestEventBridge.m'), '// predates the shared header\n');
    assert.doesNotThrow(() => assertInstalledSnapshotBridge(root));

    await writeFile(
      join(runner, 'RunnerXCTestEventBridge.m'),
      '#import "../../../snapshot-bridge/ForegroundApplicationGeometry.h"\n',
    );
    await rm(bridge, { recursive: true, force: true });
    assert.throws(
      () => assertInstalledSnapshotBridge(root),
      /dist\/apple\/snapshot-bridge\/ForegroundApplicationGeometry\.h/,
      'the runner include requires the mirror even without the apple/snapshot-bridge directory',
    );
    await writeBridge();
    assert.throws(() => assertInstalledSnapshotBridge(root), /ForegroundApplicationGeometry\.h/);
    await mkdir(join(root, 'dist', 'apple', 'snapshot-bridge'), { recursive: true });
    await writeFile(join(root, 'dist', 'apple', 'snapshot-bridge', 'x.h'), '');
    assert.throws(() => assertInstalledSnapshotBridge(root), /ForegroundApplicationGeometry\.h/);
    await writeFile(
      join(root, 'dist', 'apple', 'snapshot-bridge', 'ForegroundApplicationGeometry.h'),
      '#pragma once\n',
    );
    assert.doesNotThrow(() => assertInstalledSnapshotBridge(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
