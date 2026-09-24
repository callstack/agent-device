import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { execKillTimeoutError } from '../snapshot-source/__tests__/exec-timeout-fixture.ts';
import { createSnapshotSourceHost } from '../snapshot-source/host.ts';
import type { SnapshotSourceHost } from '../snapshot-source/types.ts';
import {
  buildFoldHelperCompileArgv,
  ensureFoldHelperBinary,
  foldHelperCacheKey,
  FOLD_HELPER_BUILD_TIMEOUT_MS,
} from './fold-helper-cache.ts';

function fakeFoldHelperHost(
  binary: () => string,
  xcodeVersion: () => string = () => 'Xcode 16.4\nBuild version 16F6',
): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    run: async (command, args) => {
      if (command === 'xcrun' && args.includes('clang')) {
        const outputPath = args.at(-1)!;
        await writeFile(outputPath, binary());
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const stdout =
        command === 'xcodebuild'
          ? xcodeVersion()
          : command === 'sw_vers'
            ? args.includes('-buildVersion')
              ? '24G90'
              : '15.6'
            : command === 'uname'
              ? 'arm64'
              : '';
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
}

test('a cache hit does not build, and a source or toolchain change does', async () => {
  const root = await mkdtempForTest('agent-device-fold-helper-cache-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'Fold.m'), 'fold source v1');

  let builds = 0;
  let xcodeVersion = 'Xcode 16.4\nBuild version 16F6';
  const host = fakeFoldHelperHost(
    () => {
      builds += 1;
      return `binary-${builds}`;
    },
    () => xcodeVersion,
  );

  try {
    const first = await ensureFoldHelperBinary({ host, sourceRoot, cacheRoot });
    assert.equal(builds, 1);
    assert.equal(await readFile(first.path, 'utf8'), 'binary-1');

    const hit = await ensureFoldHelperBinary({ host, sourceRoot, cacheRoot });
    assert.equal(hit.path, first.path);
    assert.equal(builds, 1);

    await writeFile(path.join(sourceRoot, 'Fold.m'), 'fold source v2');
    const sourceChanged = await ensureFoldHelperBinary({ host, sourceRoot, cacheRoot });
    assert.notEqual(sourceChanged.path, first.path);
    assert.equal(builds, 2);

    xcodeVersion = 'Xcode 16.5\nBuild version 16F5';
    const toolchainChanged = await ensureFoldHelperBinary({ host, sourceRoot, cacheRoot });
    assert.notEqual(toolchainChanged.path, sourceChanged.path);
    assert.equal(builds, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the fold helper cache key changes with the compile argv, independent of source and toolchain', () => {
  const sourceHash = 'same-source';
  const toolchain = {
    xcode: 'Xcode 16.4\nBuild version 16F6',
    macosProductVersion: '15.6',
    macosBuild: '24G90',
    architecture: 'arm64',
  } as const;
  const argv = ['clang', '-Wall'];
  const changedArgv = ['clang', '-Wall', '-DSomethingNew'];

  const key = foldHelperCacheKey({ sourceHash, toolchain, compileArgv: argv });
  const sameKey = foldHelperCacheKey({ sourceHash, toolchain, compileArgv: argv });
  const keyAfterArgvChange = foldHelperCacheKey({
    sourceHash,
    toolchain,
    compileArgv: changedArgv,
  });

  assert.equal(key, sameKey, 'the same argv always keys the same');
  assert.notEqual(
    key,
    keyAfterArgvChange,
    'an argv-only change (same source, same toolchain) cannot serve a stale binary',
  );
});

test('a compile exec killed at its budget reports the fold-helper build, not the exec layer', async () => {
  const root = await mkdtempForTest('agent-device-fold-helper-cache-stall-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'Fold.m'), 'fold source');
  const okHost = fakeFoldHelperHost(() => 'binary');
  const host: SnapshotSourceHost = {
    ...okHost,
    run: async (command, args, options) => {
      if (command === 'xcrun' && args.includes('clang')) throw await execKillTimeoutError();
      return await okHost.run(command, args, options);
    },
  };

  try {
    await assert.rejects(
      ensureFoldHelperBinary({ host, sourceRoot, cacheRoot }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
        assert.equal(
          (error as { details?: { reason?: string } }).details?.reason,
          'fold-helper-build-failed',
        );
        assert.equal(
          (error as { details?: { cause?: string } }).details?.cause,
          'native-build-stalled',
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// #2796: the production compile drops -Werror so a stale toolchain warning cannot fail a build;
// this is the gate that keeps a new Fold.m warning from passing CI unnoticed. It runs the
// production argv (`buildFoldHelperCompileArgv`) against the real iphonesimulator SDK with
// -Werror appended, so a warning fails here instead of nowhere.
//
// The compile runs in beforeAll, not in the test body: it is a real clang invocation (see the
// unit slow-test budget in docs/agents/testing.md), and the snapshot-bridge sibling gate in
// native-runtime.test.ts keeps its compile out of test-case wall time the same way.
describe.skipIf(process.platform !== 'darwin')('fold helper warning gate', () => {
  let compiled: { exitCode: number; stderr: string };
  beforeAll(async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '../../../../apple/fold-helper');
    const binary = path.join(await mkdtempForTest('fold-helper-werror-'), 'fold-helper');
    const argv = buildFoldHelperCompileArgv({ sourceRoot, outputPath: binary });
    const wextraIndex = argv.indexOf('-Wextra');
    assert.ok(wextraIndex >= 0, 'the production argv carries -Wextra');
    const werrorArgv = [
      ...argv.slice(0, wextraIndex + 1),
      '-Werror',
      ...argv.slice(wextraIndex + 1),
    ];
    compiled = await runCmd('xcrun', werrorArgv, {
      allowFailure: true,
      timeoutMs: FOLD_HELPER_BUILD_TIMEOUT_MS,
    });
  }, FOLD_HELPER_BUILD_TIMEOUT_MS + 30_000);

  test('the production fold helper argv compiles clean under -Werror', () => {
    assert.equal(compiled.exitCode, 0, compiled.stderr);
  });
});
