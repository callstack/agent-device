import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { createSnapshotSourceHost } from '../snapshot-source/host.ts';
import type { SnapshotSourceHost } from '../snapshot-source/types.ts';
import {
  buildWatchHelperCompileArgv,
  ensureWatchHelperBinary,
  WATCH_HELPER_BUILD_TIMEOUT_MS,
} from './watch-helper-cache.ts';

function fakeHost(onBuild: () => string): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    run: async (command, args) => {
      if (command === 'xcrun' && args.includes('clang')) {
        await writeFile(args.at(-1)!, onBuild());
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const stdout =
        command === 'xcodebuild'
          ? 'Xcode 27.0\nBuild version 17A1'
          : command === 'sw_vers'
            ? args.includes('-buildVersion')
              ? '25A1'
              : '26.0'
            : command === 'uname'
              ? 'arm64'
              : '';
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
}

test('watch helper cache builds once and reuses the content-addressed binary', async () => {
  const root = await mkdtempForTest('agent-device-watch-helper-cache-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'WatchControl.m'), 'watch source');
  let builds = 0;
  const host = fakeHost(() => `binary-${++builds}`);
  try {
    const first = await ensureWatchHelperBinary({ host, sourceRoot, cacheRoot });
    const second = await ensureWatchHelperBinary({ host, sourceRoot, cacheRoot });
    assert.equal(first.path, second.path);
    assert.equal(builds, 1);
    assert.equal(await readFile(first.path, 'utf8'), 'binary-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('watch helper compile argv links only the isolated host dependencies', () => {
  assert.deepEqual(buildWatchHelperCompileArgv({ sourceRoot: '/source', outputPath: '/out' }), [
    '--sdk',
    'macosx',
    'clang',
    '-fobjc-arc',
    '-fblocks',
    '-Wall',
    '-Wextra',
    '-framework',
    'Foundation',
    '-framework',
    'CoreGraphics',
    '/source/WatchControl.m',
    '-o',
    '/out',
  ]);
});

describe.skipIf(process.platform !== 'darwin')('watch helper warning gate', () => {
  let compiled: { exitCode: number; stderr: string };
  beforeAll(async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '../../../../apple/watch-helper');
    const outputPath = path.join(await mkdtempForTest('watch-helper-werror-'), 'watch-control');
    compiled = await runCmd(
      'xcrun',
      [...buildWatchHelperCompileArgv({ sourceRoot, outputPath }), '-Werror'],
      { allowFailure: true, timeoutMs: WATCH_HELPER_BUILD_TIMEOUT_MS },
    );
  }, WATCH_HELPER_BUILD_TIMEOUT_MS + 30_000);

  test('the production watch helper compiles clean under -Werror', () => {
    assert.equal(compiled.exitCode, 0, compiled.stderr);
  });
});
