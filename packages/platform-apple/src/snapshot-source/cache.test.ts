import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

import path from 'node:path';
import { test } from 'vitest';
import { createSnapshotSourceHost } from './host.ts';
import { ensureSnapshotBridgeBinary } from './cache.ts';
import { SnapshotSourceError } from './errors.ts';
import { createSnapshotSourceDeadline } from './deadline.ts';
import { DEFAULT_SNAPSHOT_SOURCE_LIMITS } from './limits.ts';
import type { SnapshotSourceHost } from './types.ts';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';

test('snapshot bridge preparation is cold-once, atomic, and invalidates corrupt or stale entries', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-source-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await writeFile(path.join(root, 'placeholder'), 'unused');
  const sourceFile = path.join(sourceRoot, 'SnapshotBridge.m');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(sourceFile, 'native source v1');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.m'), 'native runtime v1');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.h'), 'native header v1');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.h'), 'native header v1');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.m'), 'native header v1');

  let builds = 0;
  let xcodeVersion = 'Xcode 16.4\nBuild version 16F6';
  const host = createFakeBuildHost(
    () => {
      builds += 1;
      return `binary-${builds}`;
    },
    () => xcodeVersion,
  );

  try {
    const first = await ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });
    assert.equal(builds, 1);
    assert.equal(await readFile(first.path, 'utf8'), 'binary-1');

    const hit = await ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });
    assert.equal(hit.path, first.path);
    assert.equal(builds, 1);

    await writeFile(path.join(sourceRoot, 'README.md'), 'documentation v1');
    const differentTreeLimits = await ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: { ...DEFAULT_SNAPSHOT_SOURCE_LIMITS, maxNodes: 200, maxTraversalDepth: 12 },
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });
    assert.equal(differentTreeLimits.cacheKey, first.cacheKey);
    assert.equal(builds, 1);
    await writeFile(path.join(sourceRoot, 'README.md'), 'documentation v2');
    const documentationChanged = await ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });
    assert.equal(documentationChanged.cacheKey, first.cacheKey);
    assert.equal(builds, 1);
    const manifest = JSON.parse(
      await readFile(path.join(path.dirname(first.path), 'manifest.json'), 'utf8'),
    ) as { toolchain: { macosBuild: string } };
    assert.equal(manifest.toolchain.macosBuild, '24G90');

    await writeFile(first.path, 'corrupt');
    await ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });
    assert.equal(builds, 2);

    await writeFile(sourceFile, 'native source v2');
    const sourceChanged = await ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });
    assert.notEqual(sourceChanged.sourceHash, first.sourceHash);
    assert.equal(builds, 3);

    xcodeVersion = 'Xcode 16.5\nBuild version 16F5';
    const toolchainChanged = await ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });
    assert.notEqual(toolchainChanged.cacheKey, sourceChanged.cacheKey);
    assert.equal(builds, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent snapshot bridge preparation publishes one cache entry', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-source-concurrent-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'SnapshotBridge.m'), 'native source');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.m'), 'native runtime');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.m'), 'native header');
  let builds = 0;
  const host = createFakeBuildHost(async () => {
    builds += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return `binary-${builds}`;
  });

  try {
    const results = await Promise.all(
      [1, 2].map(() =>
        ensureSnapshotBridgeBinary({
          host,
          runtime: 'iOS 26.2',
          limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
          deadline: testDeadline(),
          sourceRoot,
          cacheRoot,
        }),
      ),
    );
    assert.equal(builds, 1);
    assert.equal(results[0]?.path, results[1]?.path);
    assert.equal(await readFile(results[0]!.path, 'utf8'), 'binary-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an aborted cache waiter does not cancel an independent preparation', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-source-abort-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'SnapshotBridge.m'), 'native source');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.m'), 'native runtime');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.m'), 'native header');
  let builds = 0;
  let buildStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    buildStarted = resolve;
  });
  const host = createFakeBuildHost(async () => {
    builds += 1;
    buildStarted();
    await new Promise((resolve) => setTimeout(resolve, 40));
    return `binary-${builds}`;
  });
  const controller = new AbortController();

  try {
    const canceled = ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: { ...DEFAULT_SNAPSHOT_SOURCE_LIMITS, maxDurationMs: 300 },
      deadline: testDeadline(300, controller.signal),
      sourceRoot,
      cacheRoot,
    });
    await started;
    controller.abort();
    const survivor = ensureSnapshotBridgeBinary({
      host,
      runtime: 'iOS 26.2',
      limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
      deadline: testDeadline(),
      sourceRoot,
      cacheRoot,
    });

    await expectRejectedCancellation(canceled);
    const result = await survivor;
    assert.equal(await readFile(result.path, 'utf8'), 'binary-2');
    assert.equal(builds, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bridge build that failed is reported over a cache lock that could not be given back', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-source-build-failure-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'SnapshotBridge.m'), 'native source');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.m'), 'native runtime');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.m'), 'native header');
  const buildHost = createFakeBuildHost('unused');
  const host: SnapshotSourceHost = {
    ...buildHost,
    run: async (command, args, options) => {
      if (command !== 'xcrun' || !args.includes('clang')) {
        return await buildHost.run(command, args, options);
      }
      // The lock beside the cache entry loses its record while the build runs, so the release
      // that follows cannot prove ownership; the build itself fails.
      const lockDir = (await readdir(cacheRoot)).find((entry) => entry.endsWith('.lock'));
      assert.ok(lockDir, 'the build runs under the cache lock');
      const ownerFile = path.join(cacheRoot, lockDir, 'owner.json');
      await rm(ownerFile);
      await mkdir(ownerFile);
      return { stdout: '', stderr: 'clang: error: build failed', exitCode: 1 };
    },
  };

  try {
    await assert.rejects(
      ensureSnapshotBridgeBinary({
        host,
        runtime: 'iOS 26.2',
        limits: DEFAULT_SNAPSHOT_SOURCE_LIMITS,
        deadline: testDeadline(),
        sourceRoot,
        cacheRoot,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotSourceError);
        assert.equal(error.failureKind, 'unsupported');
        assert.equal(error.failureCode, 'native-build-failed');
        return true;
      },
    );
    // The release really could not verify itself: the lock is still standing.
    assert.ok((await readdir(cacheRoot)).some((entry) => entry.endsWith('.lock')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function expectRejectedCancellation(value: Promise<unknown>): Promise<void> {
  await assert.rejects(value, (error: unknown) => {
    return (
      error instanceof Error &&
      'failureKind' in error &&
      (error as { failureKind: string }).failureKind === 'cancelled'
    );
  });
}

function testDeadline(
  timeoutMs = DEFAULT_SNAPSHOT_SOURCE_LIMITS.maxDurationMs,
  signal?: AbortSignal,
) {
  return createSnapshotSourceDeadline(timeoutMs, signal);
}

function createFakeBuildHost(
  binary: string | (() => string | Promise<string>),
  getXcode: () => string = () => 'Xcode 16.4\nBuild version 16F6',
): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    run: async (command, args) => {
      if (command === 'xcrun' && args.includes('clang')) {
        const outputPath = args.at(-1)!;
        const contents = typeof binary === 'function' ? await binary() : binary;
        await writeFile(outputPath, contents);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const stdout =
        command === 'xcodebuild'
          ? getXcode()
          : command === 'sw_vers'
            ? args.includes('-buildVersion')
              ? '24G90'
              : '15.6'
            : command === 'uname'
              ? 'arm64'
              : '26.2';
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
}
