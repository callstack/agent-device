import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { execKillTimeoutError } from '../native-build/__tests__/exec-timeout-fixture.ts';
import { createSnapshotSourceHost } from '../snapshot-source/host.ts';
import type { SnapshotSourceHost } from '../snapshot-source/types.ts';
import {
  buildFoldHelperCompileArgv,
  ensureFoldHelperBinary,
  FOLD_HELPER_BUILD_TIMEOUT_MS,
} from './fold-helper-cache.ts';

function fakeFoldHelperHost(
  binary: () => string,
  xcodeVersion: () => string = () => 'Xcode 16.4\nBuild version 16F6',
): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    cpuArch: async () => 'arm64',
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

test('the runtime clang build never uses -Werror', () => {
  assert.ok(!buildFoldHelperCompileArgv({ sourceRoot: '', outputPath: '' }).includes('-Werror'));
});

test('a failed compile reports fold-helper-build-failed with the compiler output', async () => {
  const root = await mkdtempForTest('agent-device-fold-helper-cache-failure-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'Fold.m'), 'fold source');
  const okHost = fakeFoldHelperHost(() => 'binary');
  const host: SnapshotSourceHost = {
    ...okHost,
    run: async (command, args, options) => {
      if (command === 'xcrun' && args.includes('clang')) {
        return { stdout: '', stderr: 'compiler detail', exitCode: 1 };
      }
      return await okHost.run(command, args, options);
    },
  };

  try {
    await assert.rejects(ensureFoldHelperBinary({ host, sourceRoot, cacheRoot }), {
      code: 'COMMAND_FAILED',
      details: {
        stdout: '',
        stderr: 'compiler detail',
        exitCode: 1,
        processExitError: true,
        hint: 'Select an Xcode with the iOS simulator SDK and foldable HID support using DEVELOPER_DIR.',
        reason: 'fold-helper-build-failed',
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.cause, 'native-build-stalled');
        assert.equal(details?.timeoutMs, FOLD_HELPER_BUILD_TIMEOUT_MS);
        assert.match(String(details?.hint), /stopped the fold helper build/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an abort while a second caller waits on the fold-helper lock reports a canceled request', async () => {
  const root = await mkdtempForTest('agent-device-fold-helper-cache-lock-wait-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'Fold.m'), 'fold source');

  let releaseClang!: () => void;
  const clangGate = new Promise<void>((resolve) => {
    releaseClang = resolve;
  });
  let clangStarted!: () => void;
  const clangStartedSignal = new Promise<void>((resolve) => {
    clangStarted = resolve;
  });
  const host = fakeFoldHelperHost(() => 'binary');
  const holdingHost: SnapshotSourceHost = {
    ...host,
    run: async (command, args, options) => {
      if (command === 'xcrun' && args.includes('clang')) {
        clangStarted();
        await clangGate;
        return await host.run(command, args, options);
      }
      return await host.run(command, args, options);
    },
  };

  try {
    // The first call acquires the fold-helper lock and holds it in its build step (gated on
    // `clangGate`) until this test releases it, so the second call below is guaranteed to find
    // the lock already held rather than racing for it.
    const holder = ensureFoldHelperBinary({ host: holdingHost, sourceRoot, cacheRoot });
    await clangStartedSignal;

    const controller = new AbortController();
    const waiter = ensureFoldHelperBinary({
      host,
      sourceRoot,
      cacheRoot,
      signal: controller.signal,
    });
    // Give the waiter time to reach the lock's poll loop before aborting it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await assert.rejects(waiter, (error: unknown) => {
      assert.ok(isRequestCanceledError(error), 'expected a canceled-request error');
      return true;
    });

    releaseClang();
    await holder;
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
    compiled = await runCmd('xcrun', [...argv, '-Werror'], {
      allowFailure: true,
      timeoutMs: FOLD_HELPER_BUILD_TIMEOUT_MS,
    });
  }, FOLD_HELPER_BUILD_TIMEOUT_MS + 30_000);

  test('the production fold helper argv compiles clean under -Werror', () => {
    assert.equal(compiled.exitCode, 0, compiled.stderr);
  });
});
