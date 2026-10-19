import { bindTestCommandHost } from '@agent-device/test-kit';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { quitMacOsApp, resolveMacOsHelperPackageRootFrom } from './helper.ts';

bindTestCommandHost();

test('resolveMacOsHelperPackageRootFrom finds helper package from source and dist-like paths', async () => {
  const repoRoot = await mkdtempForTest('agent-device-helper-root-');
  const helperRoot = path.join(repoRoot, 'apple', 'macos-helper');
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(path.join(helperRoot, 'Package.swift'), '// test\n', 'utf8');

  try {
    const sourceLike = path.join(repoRoot, 'src', 'platforms', 'ios', 'macos-helper.ts');
    const distLike = path.join(repoRoot, 'dist', 'src', 'platforms', 'ios', 'macos-helper.js');

    assert.equal(resolveMacOsHelperPackageRootFrom(sourceLike), helperRoot);
    assert.equal(resolveMacOsHelperPackageRootFrom(distLike), helperRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test('AGENT_DEVICE_MACOS_HELPER_BIN rejects relative override paths', async () => {
  const previousHelperPath = process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
  process.env.AGENT_DEVICE_MACOS_HELPER_BIN = './agent-device-macos-helper';

  try {
    await assert.rejects(() => quitMacOsApp('com.example.App', process.env), {
      code: 'INVALID_ARGS',
    });
  } finally {
    if (previousHelperPath === undefined) {
      delete process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
    } else {
      process.env.AGENT_DEVICE_MACOS_HELPER_BIN = previousHelperPath;
    }
  }
});

test('quitMacOsApp rejects invalid bundle identifiers before invoking helper', async () => {
  await assert.rejects(() => quitMacOsApp('not a bundle id', process.env), /reverse-DNS form/i);
});
