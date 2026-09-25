import { test, vi, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- mirrors production's os.tmpdir xctestrun path
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  buildRunnerSessionXctestrunCleanupPattern,
  buildRunnerSessionXctestrunSuffix,
} from '../runner-artifact-env.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';

// This script runs outside the package's host abstraction (it is invoked directly via
// dynamic import in the "setup metadata script" test below) and calls node:child_process
// execFileSync itself, so it cannot be faked through a host override; the module mock stays.
const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: mockExecFileSync };
});

const mockRunCmdSync = vi.fn();

import type { DeviceInfo } from '@agent-device/kernel/device';
import { findXctestrun, scoreXctestrunCandidate } from '../runner-artifact.ts';
import {
  ensureXctestrunArtifact,
  markRunnerXctestrunArtifactBadForRun,
  prepareXctestrunWithEnv,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
} from '../runner-xctestrun.ts';

const iosSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const iosDevice: DeviceInfo = {
  platform: 'apple',
  id: 'device-1',
  name: 'iPhone',
  kind: 'device',
  booted: true,
};

const runnerPortEnv = { AGENT_DEVICE_RUNNER_PORT: '12345' };

function appleToolFingerprintOutput(command: string, args: readonly string[]): string {
  if (command === 'xcodebuild' && args[0] === '-version') {
    return 'Xcode 26.2\nBuild version 17C52\n';
  }
  if (command === 'xcrun' && args.includes('--show-sdk-version')) return '26.2\n';
  if (command === 'xcrun' && args.includes('--show-sdk-build-version')) return '23C53\n';
  throw new Error(`Unexpected Apple fingerprint command: ${command} ${args.join(' ')}`);
}

mockExecFileSync.mockImplementation((command: string, args: readonly string[]) =>
  appleToolFingerprintOutput(command, args),
);
mockRunCmdSync.mockImplementation((command: string, args: string[]) => ({
  exitCode: 0,
  stdout: appleToolFingerprintOutput(command, args),
  stderr: '',
}));

beforeEach(() => {
  appleRunnerTestHost.update({ runCmdSync: mockRunCmdSync });
});

/**
 * `prepareXctestrunWithEnv` reads/writes the xctestrun plist via
 * `runAppleToolCommand('plutil', ...)`; fake just those calls (via a host override) the way
 * the tests previously scoped a `withCommandExecutorOverride` around the real exec layer.
 */
function fakeXctestrunPlutilToolCommand(): (
  cmd: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult> {
  return async (cmd, args, options) => {
    if (cmd !== 'plutil') {
      return appleRunnerTestHost.defaults().runAppleToolCommand(cmd, args, options);
    }
    if (args[0] === '-convert' && args[1] === 'json' && args[2] === '-o' && args[3] === '-') {
      return { stdout: fs.readFileSync(String(args[4]), 'utf8'), stderr: '', exitCode: 0 };
    }
    if (args[0] === '-convert' && args[1] === 'xml1' && args[2] === '-o') {
      fs.copyFileSync(String(args[4]), String(args[3]));
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected plutil args: ${args.join(' ')}`, exitCode: 1 };
  };
}

async function withTempDir<T>(prefix: string, fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempForTestSync(prefix);
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function prepareXctestrunJson(
  xctestrunPath: string,
  envVars: Record<string, string>,
  suffix: string,
): Promise<Record<string, any>> {
  appleRunnerTestHost.update({ runAppleToolCommand: fakeXctestrunPlutilToolCommand() });
  const prepared = await prepareXctestrunWithEnv(xctestrunPath, envVars, suffix);
  return JSON.parse(fs.readFileSync(prepared.jsonPath, 'utf8'));
}

function assertCapturePolicy(target: any): void {
  assert.equal(target?.PreferredScreenCaptureFormat, 'screenshots');
  assert.equal(target?.SystemAttachmentLifetime, 'keepNever');
  assert.equal(target?.UserAttachmentLifetime, 'keepNever');
}

function assertNoCapturePolicy(target: any): void {
  assert.equal(target?.PreferredScreenCaptureFormat, undefined);
  assert.equal(target?.SystemAttachmentLifetime, undefined);
  assert.equal(target?.UserAttachmentLifetime, undefined);
}

test('findXctestrun prefers simulator xctestrun over newer macos candidate', () => {
  const root = mkdtempForTestSync('runner-xctestrun-');
  try {
    const simulatorPath = path.join(
      root,
      'Build',
      'Products',
      'AgentDeviceRunner_AgentDeviceRunner_iphonesimulator26.2-arm64-x86_64.xctestrun',
    );
    const macosPath = path.join(
      root,
      'macos',
      'Build',
      'Products',
      'AgentDeviceRunner.env.session-123.xctestrun',
    );
    fs.mkdirSync(path.dirname(simulatorPath), { recursive: true });
    fs.mkdirSync(path.dirname(macosPath), { recursive: true });
    fs.writeFileSync(simulatorPath, 'sim');
    fs.writeFileSync(macosPath, 'mac');
    const now = new Date();
    fs.utimesSync(simulatorPath, now, now);
    fs.utimesSync(macosPath, new Date(now.getTime() + 5_000), new Date(now.getTime() + 5_000));

    assert.equal(findXctestrun(root, iosSimulator), simulatorPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findXctestrun prefers base xctestrun over newer env xctestrun for matching platform', () => {
  const root = mkdtempForTestSync('runner-xctestrun-');
  try {
    const basePath = path.join(
      root,
      'Build',
      'Products',
      'AgentDeviceRunner_AgentDeviceRunner_iphoneos26.2-arm64.xctestrun',
    );
    const envPath = path.join(
      root,
      'Build',
      'Products',
      'AgentDeviceRunner.env.session-456.xctestrun',
    );
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, 'base');
    fs.writeFileSync(envPath, 'env');
    const now = new Date();
    fs.utimesSync(basePath, now, now);
    fs.utimesSync(envPath, new Date(now.getTime() + 5_000), new Date(now.getTime() + 5_000));

    assert.equal(findXctestrun(root, iosDevice), basePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreXctestrunCandidate penalizes macos and env xctestrun files for simulator runs', () => {
  const simulatorScore = scoreXctestrunCandidate(
    '/tmp/derived/Build/Products/AgentDeviceRunner_AgentDeviceRunner_iphonesimulator26.2-arm64.xctestrun',
    iosSimulator,
  );
  const macosEnvScore = scoreXctestrunCandidate(
    '/tmp/derived/macos/Build/Products/AgentDeviceRunner.env.session-123.xctestrun',
    iosSimulator,
  );

  assert.ok(simulatorScore > macosEnvScore);
});

test('setup metadata script matches expected iOS simulator cache metadata', async () => {
  await withTempDir('runner-cache-metadata-', async (root) => {
    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, 'scripts', 'write-xcuitest-cache-metadata.mjs');
    const projectRoot = path.join(root, 'project');
    const derivedRoot = path.join(root, 'derived');
    fs.mkdirSync(derivedRoot, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"version":"0.19.0"}\n');
    fs.writeFileSync(
      path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'Runner.swift'),
      'final class Runner {}\n',
    );
    const runnerUnitTest = path.join(
      projectRoot,
      'apple',
      'runner',
      'AgentDeviceRunner',
      'AgentDeviceRunnerUITests',
      'UnitTests',
      'Invariant.swift',
    );
    fs.mkdirSync(path.dirname(runnerUnitTest), { recursive: true });
    fs.writeFileSync(runnerUnitTest, 'unit-one\n');
    const ignoredSharedSource = path.join(
      projectRoot,
      'apple',
      'snapshot-presentation',
      'Tests',
      'Ignored.swift',
    );
    fs.mkdirSync(path.dirname(ignoredSharedSource), { recursive: true });
    fs.writeFileSync(ignoredSharedSource, 'ignored-one\n');
    const { writeXcuitestCacheMetadata } = await import(
      `${pathToFileURL(scriptPath).href}?case=${Date.now()}`
    );
    const firstMetadata = writeXcuitestCacheMetadata(
      ['ios', derivedRoot, 'generic/platform=iOS Simulator'],
      projectRoot,
    );

    const actual = JSON.parse(
      fs.readFileSync(path.join(derivedRoot, '.agent-device-runner-cache.json'), 'utf8'),
    );
    const { artifacts: _actualArtifacts, ...actualComparable } = actual;
    const { artifacts: _expectedArtifacts, ...expectedComparable } =
      resolveExpectedRunnerCacheMetadata(iosSimulator, projectRoot);

    assert.deepEqual(actualComparable, expectedComparable);

    fs.writeFileSync(ignoredSharedSource, 'ignored-two\n');
    const secondMetadata = writeXcuitestCacheMetadata(
      ['ios', derivedRoot, 'generic/platform=iOS Simulator'],
      projectRoot,
    );
    assert.equal(secondMetadata.runnerSourceFingerprint, firstMetadata.runnerSourceFingerprint);

    fs.writeFileSync(runnerUnitTest, 'unit-two\n');
    const thirdMetadata = writeXcuitestCacheMetadata(
      ['ios', derivedRoot, 'generic/platform=iOS Simulator'],
      projectRoot,
    );
    assert.notEqual(thirdMetadata.runnerSourceFingerprint, secondMetadata.runnerSourceFingerprint);
  });
}, 15_000);

test('runner cache key ignores package version but honors toolchain and SDK changes', () => {
  const metadata = resolveExpectedRunnerCacheMetadata(iosSimulator);
  const basePath = resolveRunnerDerivedPath(iosSimulator, metadata);

  assert.equal(
    resolveRunnerDerivedPath(iosSimulator, {
      ...metadata,
      packageVersion: `${metadata.packageVersion}-next`,
    }),
    basePath,
  );
  assert.notEqual(
    resolveRunnerDerivedPath(iosSimulator, {
      ...metadata,
      xcodeBuildVersion: `${metadata.xcodeBuildVersion}-other`,
    }),
    basePath,
  );
  assert.notEqual(
    resolveRunnerDerivedPath(iosSimulator, {
      ...metadata,
      sdkBuildVersion: `${metadata.sdkBuildVersion}-other`,
    }),
    basePath,
  );
});

test('prepareXctestrunWithEnv avoids XCTest screen recordings for nested and legacy targets', async () => {
  await withTempDir('runner-xctestrun-policy-', async (root) => {
    const xctestrunPath = path.join(root, 'AgentDeviceRunner.xctestrun');
    fs.writeFileSync(
      xctestrunPath,
      JSON.stringify({
        AgentDeviceRunnerUITests: {
          TestBundlePath: '__TESTHOST__/PlugIns/AgentDeviceRunnerUITests.xctest',
          PreferredScreenCaptureFormat: 'screenRecording',
        },
        TestConfigurations: [
          {
            TestTargets: [
              {
                TestBundlePath: '__TESTHOST__/PlugIns/AgentDeviceRunnerUITests.xctest',
                PreferredScreenCaptureFormat: 'screenRecording',
                SystemAttachmentLifetime: 'deleteOnSuccess',
                UserAttachmentLifetime: 'deleteOnSuccess',
              },
            ],
          },
        ],
      }),
    );

    const parsed = await prepareXctestrunJson(xctestrunPath, runnerPortEnv, 'policy');
    const target = parsed.TestConfigurations[0]?.TestTargets[0];

    assert.equal(target?.EnvironmentVariables?.AGENT_DEVICE_RUNNER_PORT, '12345');
    assertCapturePolicy(target);
    assertCapturePolicy(parsed.AgentDeviceRunnerUITests);
  });
});

test('prepareXctestrunWithEnv writes env overlays into configured env dir', async () => {
  await withTempDir('runner-xctestrun-env-dir-', async (root) => {
    const xctestrunPath = path.join(root, 'readonly-artifacts', 'AgentDeviceRunner.xctestrun');
    const envDir = path.join(root, 'writable-env');
    fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
    fs.writeFileSync(
      xctestrunPath,
      JSON.stringify({
        TestConfigurations: [{ TestTargets: [{ TestBundlePath: 'AgentDeviceRunnerUITests' }] }],
      }),
    );

    appleRunnerTestHost.update({ runAppleToolCommand: fakeXctestrunPlutilToolCommand() });
    const prepared = await prepareXctestrunWithEnv(xctestrunPath, runnerPortEnv, 'aws session', {
      iosXctestEnvDir: envDir,
    });

    assert.equal(path.dirname(prepared.xctestrunPath), envDir);
    assert.equal(path.dirname(prepared.jsonPath), envDir);
    assert.equal(
      path.basename(prepared.xctestrunPath),
      'AgentDeviceRunner.env.aws_session.xctestrun',
    );
    assert.equal(fs.existsSync(prepared.xctestrunPath), true);
    assert.equal(fs.existsSync(prepared.jsonPath), true);
  });
});

test('the session xctestrun the writer builds is found by the cleanup matcher', async () => {
  // The launch is killed by `pkill -f` on a pattern the writer module itself builds, and the
  // daemon-client sweep pins its own looser copy of these bytes. Binding writer to pattern and to
  // those pinned bytes here is what makes a rename that keeps each side self-consistent fail.
  await withTempDir('runner-xctestrun-identity-', async (root) => {
    const xctestrunPath = path.join(root, 'AgentDeviceRunner.xctestrun');
    fs.writeFileSync(
      xctestrunPath,
      JSON.stringify({
        TestConfigurations: [{ TestTargets: [{ TestBundlePath: 'AgentDeviceRunnerUITests' }] }],
      }),
    );
    appleRunnerTestHost.update({ runAppleToolCommand: fakeXctestrunPlutilToolCommand() });
    const suffix = buildRunnerSessionXctestrunSuffix({
      deviceId: 'SIM-001',
      ownerToken: 'owner-4242-ab12cd34',
      port: 8123,
    });

    const prepared = await prepareXctestrunWithEnv(xctestrunPath, runnerPortEnv, suffix);
    const argv = `xcodebuild test-without-building -xctestrun ${prepared.xctestrunPath}`;

    // The bytes the timeout sweep pins literally, so the sweep cannot drift off the writer's name.
    assert.match(argv, new RegExp(String.raw`xcodebuild .*AgentDeviceRunner\.env\.session-`));
    assert.match(
      argv,
      new RegExp(
        `xcodebuild.*test-without-building.*${buildRunnerSessionXctestrunCleanupPattern({
          deviceId: 'SIM-001',
          ownerToken: 'owner-4242-ab12cd34',
        })}`,
      ),
    );
  });
});

test('prepareXctestrunWithEnv leaves unrelated targets without capture policy', async () => {
  await withTempDir('runner-xctestrun-policy-', async (root) => {
    const xctestrunPath = path.join(root, 'AgentDeviceRunner.xctestrun');
    const original = {
      ContainerInfo: { SchemeName: 'AgentDeviceRunner' },
      TestConfigurations: [{ TestTargets: [{}] }],
    };
    fs.writeFileSync(xctestrunPath, JSON.stringify(original));

    const parsed = await prepareXctestrunJson(xctestrunPath, runnerPortEnv, 'policy-no-targets');
    const target = parsed.TestConfigurations[0]?.TestTargets[0];

    assert.equal(target?.EnvironmentVariables?.AGENT_DEVICE_RUNNER_PORT, '12345');
    assertNoCapturePolicy(target);
    assert.deepEqual(parsed.ContainerInfo, original.ContainerInfo);
  });
});

test('ensureXctestrunArtifact uses configured external xctestrun artifact', async () => {
  await withTempDir('runner-xctestrun-external-', async (root) => {
    const xctestrunPath = path.join(root, 'aws', 'AgentDeviceRunner.xctestrun');
    const derivedPath = path.join(root, 'derived');
    fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
    fs.writeFileSync(xctestrunPath, '{}');

    const artifact = await ensureXctestrunArtifact(iosDevice, {
      forceRunnerXctestrunRebuild: true,
      iosXctestrunFile: xctestrunPath,
      iosXctestDerivedDataPath: derivedPath,
    });

    assert.equal(artifact.xctestrunPath, xctestrunPath);
    assert.equal(artifact.derived, derivedPath);
    assert.equal(artifact.cache, 'external');
    assert.equal(artifact.artifact, 'valid');
    assert.equal(artifact.buildMs, 0);
    assert.equal(artifact.xctestrunPathSource, 'external');
  });
});

test('ensureXctestrunArtifact defaults external derived data to writable temp path', async () => {
  await withTempDir('runner-xctestrun-external-temp-', async (root) => {
    const xctestrunPath = path.join(root, 'aws', 'AgentDeviceRunner.xctestrun');
    fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
    fs.writeFileSync(xctestrunPath, '{}');

    const artifact = await ensureXctestrunArtifact(iosDevice, {
      iosXctestrunFile: xctestrunPath,
    });

    const expectedRoot = path.join(os.tmpdir(), 'agent-device-ios-xctest-derived');
    assert.equal(artifact.derived.startsWith(expectedRoot), true);
    assert.notEqual(artifact.derived, path.dirname(xctestrunPath));
  });
});

test('markRunnerXctestrunArtifactBadForRun preserves configured external artifacts', async () => {
  await withTempDir('runner-xctestrun-external-bad-', async (root) => {
    const derivedPath = path.join(root, 'derived');
    const xctestrunPath = path.join(root, 'aws', 'AgentDeviceRunner.xctestrun');
    fs.mkdirSync(derivedPath, { recursive: true });
    fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
    fs.writeFileSync(path.join(derivedPath, 'keep.txt'), 'derived');
    fs.writeFileSync(xctestrunPath, 'xctestrun');

    await markRunnerXctestrunArtifactBadForRun(
      {
        xctestrunPath,
        derived: derivedPath,
        cache: 'external',
      },
      'runner health failed',
    );

    assert.equal(fs.existsSync(path.join(derivedPath, 'keep.txt')), true);
    assert.equal(fs.existsSync(xctestrunPath), true);
  });
});
