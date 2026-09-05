import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
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
    assert.doesNotThrow(() => assertInstalledSnapshotBridge(root));
    await rm(join(bridge, 'SnapshotBridgeRuntime.h'));
    assert.throws(() => assertInstalledSnapshotBridge(root), /SnapshotBridgeRuntime\.h/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
