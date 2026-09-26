import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import { beforeEach, onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appleRunnerTestHost } from '../test-host.ts';
import { resolveRunnerCacheMetadataPath } from '../runner-cache.ts';
import { ensureXctestrunArtifact } from '../runner-artifact.ts';
import {
  createRunnerPhaseBudget,
  markRunnerXctestrunArtifactBadForRun,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
} from '../runner-xctestrun.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import {
  REPO_ROOT_FOR_TEST as repoRoot,
  makeCachedRunnerXctestrun,
  makeProjectScratchDir,
  makeScratchDir,
  RUNNER_FIXTURE_EXECUTABLE_BYTES,
  seedRunnerProductBundle,
  stripRunnerCacheArtifacts,
  withRunnerDerivedPathEnv,
  withoutRunnerDerivedPathEnv,
  writeRunnerCacheMetadataWithArtifacts,
  writeXctestrunFixture,
} from './runner-xctestrun.fixtures.ts';

/** Certifies a fixture tree the way the production writer would, and proves it worked. */
async function writeCertifiedRunnerMetadata(params: {
  derivedPath: string;
  device: DeviceInfo;
  xctestrunPath: string;
  productPaths: string[];
}): Promise<void> {
  assert.equal(await writeRunnerCacheMetadataWithArtifacts(params), null);
}

const mockRunCmdStreaming = vi.fn();
const { mockRepairMacOsRunnerProductsIfNeeded } = vi.hoisted(() => ({
  mockRepairMacOsRunnerProductsIfNeeded: vi.fn(),
}));

vi.mock('../runner-macos-products.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-macos-products.ts')>(
    '../runner-macos-products.ts',
  );
  return {
    ...actual,
    repairMacOsRunnerProductsIfNeeded: mockRepairMacOsRunnerProductsIfNeeded,
  };
});

import type { DeviceInfo } from '@agent-device/kernel/device';

const iosSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

const macOsDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

/**
 * `ensureXctestrunArtifact` decides between reusing a certified DerivedData tree and rebuilding
 * one. The cases below are that decision table: what a manifest does and does not certify, what
 * survives repair, and what gets discarded before a rebuild can bless it.
 */

beforeEach(() => {
  vi.resetAllMocks();
  appleRunnerTestHost.update({
    runCmdStreaming: mockRunCmdStreaming,
    runCmdSync: appleToolchainProbeResult,
    readProcessStartTime: () => 'test-process-start',
  });
  mockRunCmdStreaming.mockResolvedValue(undefined);
  mockRepairMacOsRunnerProductsIfNeeded.mockResolvedValue(undefined);
});

test('ensureXctestrunArtifact reuses matching manifest artifacts from another project root', async () => {
  const tmpDir = await makeScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const productPath = path.join(derivedPath, 'Runner.app');
  const xctestrunPath = path.join(derivedPath, 'manifest.xctestrun');
  await seedRunnerProductBundle(productPath);
  writeXctestrunFixture(xctestrunPath, {
    projectRoot: '/tmp/other-agent-device-worktree',
    productRelativePaths: ['Runner.app'],
  });
  await writeCertifiedRunnerMetadata({
    derivedPath,
    device: macOsDevice,
    xctestrunPath,
    productPaths: [productPath],
  });
  withRunnerDerivedPathEnv(derivedPath);

  const result = (await ensureXctestrunArtifact(macOsDevice, {})).xctestrunPath;

  assert.equal(result, xctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.deepEqual(mockRepairMacOsRunnerProductsIfNeeded.mock.calls[0]?.[1], [productPath]);
});

test('ensureXctestrunArtifact rebuilds foreign artifacts when metadata does not match', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const productPath = path.join(derivedPath, 'Runner.app');
  const foreignXctestrunPath = path.join(derivedPath, 'foreign.xctestrun');
  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');
  await seedRunnerProductBundle(productPath);
  writeXctestrunFixture(foreignXctestrunPath, {
    projectRoot: '/tmp/other-agent-device-worktree',
    productRelativePaths: ['Runner.app'],
  });
  await writeCertifiedRunnerMetadata({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: foreignXctestrunPath,
    productPaths: [productPath],
  });
  const metadataPath = resolveRunnerCacheMetadataPath(derivedPath);
  const staleMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  staleMetadata.runnerSandboxBuildArgs = staleMetadata.runnerSandboxBuildArgs.map((arg: string) =>
    arg.startsWith('OTHER_SWIFT_FLAGS=')
      ? 'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_UNIT_TESTS'
      : arg,
  );
  fs.writeFileSync(metadataPath, JSON.stringify(staleMetadata, null, 2));
  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementation(async () => {
    await seedRunnerProductBundle(path.join(derivedPath, 'rebuilt', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = (await ensureXctestrunArtifact(macOsDevice, {})).xctestrunPath;

  assert.equal(result, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(fs.existsSync(foreignXctestrunPath), false);
});

test('ensureXctestrunArtifact ignores manifest artifacts outside the cache root', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const externalDir = path.join(tmpDir, 'external');
  const externalProductPath = path.join(externalDir, 'Runner.app');
  const externalXctestrunPath = path.join(externalDir, 'external.xctestrun');
  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');
  await seedRunnerProductBundle(externalProductPath);
  writeXctestrunFixture(externalXctestrunPath, {
    projectRoot,
    productRelativePaths: ['Runner.app'],
  });
  await fs.promises.mkdir(derivedPath, { recursive: true });
  // A manifest naming paths outside its own cache root cannot have been written for this tree,
  // so the reader declines it. The production writer refuses to publish one, hence the hand-off.
  fs.writeFileSync(
    resolveRunnerCacheMetadataPath(derivedPath),
    JSON.stringify({
      ...resolveExpectedRunnerCacheMetadata(macOsDevice, projectRoot),
      artifacts: {
        xctestrunPath: externalXctestrunPath,
        xctestrunSize: fs.statSync(externalXctestrunPath).size,
        xctestrunDigest: '0'.repeat(64),
        productPaths: [externalProductPath],
        entries: [{ path: 'Runner', size: 1, mode: 0o755, digest: '1'.repeat(64) }],
      },
    }),
  );
  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementation(async () => {
    await seedRunnerProductBundle(path.join(derivedPath, 'rebuilt', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = (await ensureXctestrunArtifact(macOsDevice, {})).xctestrunPath;

  assert.equal(result, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
});

test('ensureXctestrunArtifact aborts only the disconnected request build and preserves concurrent unrelated builds', async () => {
  // The request AbortSignal must reach the xctestrun build (killProcessTree via
  // runCmdStreaming); removing global abort must not orphan a disconnected prep.
  // Request-scoped: aborting one request's build leaves an unrelated concurrent
  // build (different device -> different derived, different signal) untouched.
  withoutRunnerDerivedPathEnv();
  const canceledDevice = iosSimulator;
  const survivorDevice = macOsDevice;
  for (const device of [canceledDevice, survivorDevice]) {
    const derived = resolveRunnerDerivedPath(
      device,
      resolveExpectedRunnerCacheMetadata(device, repoRoot),
    );
    onTestFinished(async () => {
      await fs.promises.rm(derived, { recursive: true, force: true });
    });
  }

  const canceledController = new AbortController();
  const survivorController = new AbortController();
  const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const waitForAbort = (signal: AbortSignal): Promise<void> =>
    signal.aborted
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
  const canceledBuildStarted = deferred<void>();
  const survivorBuildStarted = deferred<void>();
  const releaseSurvivor = deferred<void>();
  const cancellationError = createRequestCanceledError();

  mockRunCmdStreaming.mockImplementation(async (_cmd, args, options) => {
    const derived = args[args.indexOf('-derivedDataPath') + 1];
    if (options?.signal === canceledController.signal) {
      canceledBuildStarted.resolve();
      await waitForAbort(options.signal);
      throw cancellationError;
    }
    survivorBuildStarted.resolve();
    await releaseSurvivor.promise;
    await seedRunnerProductBundle(path.join(derived, 'rebuilt', 'Runner.app'));
    writeXctestrunFixture(path.join(derived, 'rebuilt', 'rebuilt.xctestrun'), {
      projectRoot: repoRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const canceledPromise = ensureXctestrunArtifact(canceledDevice, {
    budget: createRunnerPhaseBudget(undefined, canceledController.signal),
  });
  const survivorPromise = ensureXctestrunArtifact(survivorDevice, {
    budget: createRunnerPhaseBudget(undefined, survivorController.signal),
  });

  await Promise.all([canceledBuildStarted.promise, survivorBuildStarted.promise]);

  canceledController.abort();
  await assert.rejects(canceledPromise, (error: unknown) => {
    assert.equal(error, cancellationError);
    assert.ok(isRequestCanceledError(error));
    return true;
  });
  // The unrelated concurrent build's signal was never aborted.
  assert.equal(survivorController.signal.aborted, false);

  releaseSurvivor.resolve();
  const survivorResult = await survivorPromise;
  assert.ok(survivorResult.xctestrunPath.endsWith('rebuilt.xctestrun'));

  const canceledCall = mockRunCmdStreaming.mock.calls.find(
    (call) => call[2]?.signal === canceledController.signal,
  );
  const survivorCall = mockRunCmdStreaming.mock.calls.find(
    (call) => call[2]?.signal === survivorController.signal,
  );
  assert.ok(canceledCall, 'canceled build received its request signal');
  assert.ok(survivorCall, 'survivor build received its request signal');
});

test('ensureXctestrunArtifact rebuilds after cached macOS runner repair failure', async () => {
  // Cached runner artifacts can look reusable until ad-hoc repair fails; ensure we clean once,
  // rebuild, and return the repaired rebuilt xctestrun instead of looping on stale cache state.
  const projectRoot = repoRoot;
  const { derivedPath, existingXctestrunPath } = await makeCachedRunnerXctestrun(macOsDevice);
  const projectPath = path.join(
    projectRoot,
    'apple',
    'runner',
    'AgentDeviceRunner',
    'AgentDeviceRunner.xcodeproj',
  );

  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');

  withRunnerDerivedPathEnv(derivedPath);

  const repairedPaths: string[] = [];

  mockRepairMacOsRunnerProductsIfNeeded.mockImplementation(
    async (_device, _productPaths, xctestrunPath) => {
      repairedPaths.push(xctestrunPath);
      if (xctestrunPath === existingXctestrunPath) {
        throw new AppError('COMMAND_FAILED', 'cached runner is damaged', {
          reason: 'RUNNER_PRODUCT_REPAIR_FAILED',
        });
      }
    },
  );
  mockRunCmdStreaming.mockImplementation(async (command, args) => {
    assert.equal(command, 'xcodebuild');
    assert.ok(Array.isArray(args));
    assert.equal(args[args.indexOf('-project') + 1], projectPath);
    assert.equal(args[args.indexOf('-derivedDataPath') + 1], derivedPath);
    await seedRunnerProductBundle(path.join(derivedPath, 'rebuilt', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = (await ensureXctestrunArtifact(macOsDevice, {})).xctestrunPath;

  assert.equal(result, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(fs.existsSync(existingXctestrunPath), false);
  assert.deepEqual(repairedPaths, [existingXctestrunPath, rebuiltXctestrunPath]);
});

test('ensureXctestrunArtifact prefers validated cache manifest over recursive scan', async () => {
  const tmpDir = await makeScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const manifestProductPath = path.join(derivedPath, 'ManifestRunner.app');
  const manifestXctestrunPath = path.join(derivedPath, 'manifest.xctestrun');
  const newerProductPath = path.join(derivedPath, 'NewerRunner.app');
  const newerXctestrunPath = path.join(derivedPath, 'newer.xctestrun');
  await seedRunnerProductBundle(manifestProductPath);
  await seedRunnerProductBundle(newerProductPath);
  writeXctestrunFixture(manifestXctestrunPath, {
    projectRoot: repoRoot,
    productRelativePaths: ['ManifestRunner.app'],
  });
  writeXctestrunFixture(newerXctestrunPath, {
    projectRoot: repoRoot,
    productRelativePaths: ['NewerRunner.app'],
  });
  const now = new Date();
  fs.utimesSync(manifestXctestrunPath, now, now);
  fs.utimesSync(
    newerXctestrunPath,
    new Date(now.getTime() + 5_000),
    new Date(now.getTime() + 5_000),
  );
  await writeCertifiedRunnerMetadata({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: manifestXctestrunPath,
    productPaths: [manifestProductPath],
  });
  withRunnerDerivedPathEnv(derivedPath);

  const result = (await ensureXctestrunArtifact(macOsDevice, {})).xctestrunPath;

  assert.equal(result, manifestXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.deepEqual(mockRepairMacOsRunnerProductsIfNeeded.mock.calls[0]?.[1], [manifestProductPath]);
});

test('ensureXctestrunArtifact ignores a newer foreign xctestrun beside a certified build', async () => {
  // The product-discovery scan is gone: a certified manifest is the only reuse authority, so
  // a newer .xctestrun that nothing certifies cannot be blessed over it.
  const tmpDir = await makeScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const manifestProductPath = path.join(derivedPath, 'ManifestRunner.app');
  const manifestXctestrunPath = path.join(derivedPath, 'manifest.xctestrun');
  const newerProductPath = path.join(derivedPath, 'NewerRunner.app');
  const newerXctestrunPath = path.join(derivedPath, 'newer.xctestrun');
  await seedRunnerProductBundle(manifestProductPath);
  await seedRunnerProductBundle(newerProductPath);
  writeXctestrunFixture(manifestXctestrunPath, {
    projectRoot: repoRoot,
    productRelativePaths: ['ManifestRunner.app'],
  });
  writeXctestrunFixture(newerXctestrunPath, {
    projectRoot: repoRoot,
    productRelativePaths: ['NewerRunner.app'],
  });
  const now = new Date();
  fs.utimesSync(manifestXctestrunPath, now, now);
  fs.utimesSync(
    newerXctestrunPath,
    new Date(now.getTime() + 5_000),
    new Date(now.getTime() + 5_000),
  );
  await writeCertifiedRunnerMetadata({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: manifestXctestrunPath,
    productPaths: [manifestProductPath],
  });
  withRunnerDerivedPathEnv(derivedPath);

  const result = (await ensureXctestrunArtifact(macOsDevice, {})).xctestrunPath;

  assert.equal(result, manifestXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.deepEqual(mockRepairMacOsRunnerProductsIfNeeded.mock.calls[0]?.[1], [manifestProductPath]);
});

test('ensureXctestrunArtifact discards and rebuilds a manifest whose bytes no longer match', async () => {
  const tmpDir = await makeProjectScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const productPath = path.join(derivedPath, 'Runner.app');
  const cachedXctestrunPath = path.join(derivedPath, 'cached.xctestrun');
  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');
  await seedRunnerProductBundle(productPath);
  writeXctestrunFixture(cachedXctestrunPath, {
    projectRoot: repoRoot,
    productRelativePaths: ['Runner.app'],
  });
  await writeCertifiedRunnerMetadata({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: cachedXctestrunPath,
    productPaths: [productPath],
  });
  // The failure the old stat signature could not see: same length, same mtime, new bytes, so
  // only a digest can tell. A shorter replacement would trip `size_changed` first.
  const executablePath = path.join(productPath, 'Runner');
  const tampered = Buffer.from(RUNNER_FIXTURE_EXECUTABLE_BYTES);
  tampered[tampered.length - 2] = 'x'.charCodeAt(0);
  assert.equal(tampered.length, RUNNER_FIXTURE_EXECUTABLE_BYTES.length);
  const stat = fs.statSync(executablePath);
  fs.writeFileSync(executablePath, tampered, { mode: 0o755 });
  fs.utimesSync(executablePath, stat.atime, stat.mtime);
  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementation(async () => {
    await seedRunnerProductBundle(path.join(derivedPath, 'rebuilt', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot: repoRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = await ensureXctestrunArtifact(macOsDevice, {});

  assert.equal(result.xctestrunPath, rebuiltXctestrunPath);
  assert.equal(result.reason, 'artifact_content_mismatch');
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(fs.existsSync(cachedXctestrunPath), false);
});

test('ensureXctestrunArtifact rebuilds cached runner when Swift build flags mismatch', async () => {
  const projectRoot = repoRoot;
  const { derivedPath, existingXctestrunPath } = await makeCachedRunnerXctestrun(macOsDevice);
  const metadataPath = resolveRunnerCacheMetadataPath(derivedPath);
  const expectedMetadata = resolveExpectedRunnerCacheMetadata(macOsDevice, repoRoot);
  const staleMetadata = {
    ...expectedMetadata,
    runnerSandboxBuildArgs: expectedMetadata.runnerSandboxBuildArgs.map((arg) =>
      arg.startsWith('OTHER_SWIFT_FLAGS=')
        ? 'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_UNIT_TESTS'
        : arg,
    ),
  };
  fs.writeFileSync(metadataPath, JSON.stringify(staleMetadata, null, 2));

  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');

  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementation(async () => {
    await seedRunnerProductBundle(path.join(derivedPath, 'rebuilt', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = (await ensureXctestrunArtifact(macOsDevice, {})).xctestrunPath;

  assert.equal(result, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(fs.existsSync(existingXctestrunPath), false);
  const rebuiltMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.deepEqual(
    stripRunnerCacheArtifacts(rebuiltMetadata),
    resolveExpectedRunnerCacheMetadata(macOsDevice, repoRoot),
  );
  assert.equal(rebuiltMetadata.artifacts?.xctestrunPath, rebuiltXctestrunPath);
});

test('ensureXctestrunArtifact passes sandbox-disabling settings to xcodebuild', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const rebuiltXctestrunPath = path.join(derivedPath, 'Build', 'Products', 'rebuilt.xctestrun');

  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementationOnce(async () => {
    await seedRunnerProductBundle(path.join(derivedPath, 'Build', 'Products', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = await ensureXctestrunArtifact(iosSimulator, {
    forceRunnerXctestrunRebuild: true,
  });

  assert.equal(result.xctestrunPath, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  const args = mockRunCmdStreaming.mock.calls[0]?.[1] ?? [];
  assert.equal(args.includes('-IDEPackageSupportDisableManifestSandbox=1'), true);
  assert.equal(args.includes('-IDEPackageSupportDisablePluginExecutionSandbox=1'), true);
  assert.equal(args.includes('ENABLE_USER_SCRIPT_SANDBOXING=NO'), true);
  assert.equal(
    args.includes(
      'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY',
    ),
    true,
  );
});

test('ensureXctestrunArtifact emits build progress on cache miss', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const rebuiltXctestrunPath = path.join(derivedPath, 'Build', 'Products', 'rebuilt.xctestrun');
  const events: RequestProgressEvent[] = [];

  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementationOnce(async () => {
    await seedRunnerProductBundle(path.join(derivedPath, 'Build', 'Products', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  appleRunnerTestHost.update({ emitRequestProgress: (event) => events.push(event) });

  const result = await ensureXctestrunArtifact(iosSimulator, {
    forceRunnerXctestrunRebuild: true,
  });

  assert.equal(result.xctestrunPath, rebuiltXctestrunPath);
  assert.deepEqual(events, [
    {
      type: 'command',
      status: 'progress',
      message: 'Building Apple runner...',
    },
  ]);
});

test('ensureXctestrunArtifact stress-recovers after a bad restored artifact', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const productPath = path.join(derivedPath, 'Runner.app');
  const cachedXctestrunPath = path.join(derivedPath, 'cached.xctestrun');
  await seedRunnerProductBundle(productPath);
  writeXctestrunFixture(cachedXctestrunPath, {
    projectRoot,
    productRelativePaths: ['Runner.app'],
  });
  await writeCertifiedRunnerMetadata({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: cachedXctestrunPath,
    productPaths: [productPath],
  });
  withRunnerDerivedPathEnv(derivedPath);

  const hit = await ensureXctestrunArtifact(macOsDevice, {});

  assert.equal(hit.xctestrunPath, cachedXctestrunPath);
  assert.equal(hit.cache, 'exact');
  assert.equal(hit.artifact, 'valid');
  assert.equal(hit.buildMs, 0);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);

  await markRunnerXctestrunArtifactBadForRun(hit, 'stress health failed');
  assert.equal(fs.existsSync(cachedXctestrunPath), false);

  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');
  mockRunCmdStreaming.mockImplementationOnce(async () => {
    await seedRunnerProductBundle(path.join(derivedPath, 'rebuilt', 'Runner.app'));
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const rebuilt = await ensureXctestrunArtifact(macOsDevice, {
    budget: createRunnerPhaseBudget(300_000, undefined),
  });

  assert.equal(rebuilt.xctestrunPath, rebuiltXctestrunPath);
  assert.equal(rebuilt.cache, 'miss');
  assert.equal(rebuilt.artifact, 'rebuilt');
  assert.equal(rebuilt.reason, 'cache_metadata_missing');
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(Math.ceil(Number(mockRunCmdStreaming.mock.calls[0]?.[2]?.timeoutMs) / 1e3), 300); // phase remainder (#2422)
});

test('ensureXctestrunArtifact rethrows unexpected cached macOS runner repair errors', async () => {
  const { derivedPath, existingXctestrunPath } = await makeCachedRunnerXctestrun(macOsDevice);

  withRunnerDerivedPathEnv(derivedPath);

  mockRepairMacOsRunnerProductsIfNeeded.mockRejectedValue(new Error('permission denied'));

  await assert.rejects(ensureXctestrunArtifact(macOsDevice, {}), /permission denied/);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.equal(fs.existsSync(existingXctestrunPath), true);
});
