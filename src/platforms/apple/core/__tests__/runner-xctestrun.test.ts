import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DeviceInfo } from '../../../../kernel/device.ts';
import { withCommandExecutorOverride } from '../../../../utils/exec.ts';
import { findXctestrun, scoreXctestrunCandidate } from '../runner/runner-artifact.ts';
import { resolveXcodebuildSimulatorDeviceSetPath } from '../runner/runner-device-set.ts';
import {
  acquireXcodebuildSimulatorSetRedirect,
  ensureXctestrunArtifact,
  markRunnerXctestrunArtifactBadForRun,
  prepareXctestrunWithEnv,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
} from '../runner/runner-xctestrun.ts';

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

type RedirectPaths = {
  requestedSetPath: string;
  xctestDeviceSetPath: string;
  lockDirPath: string;
  backupPath: string;
};

const runnerPortEnv = { AGENT_DEVICE_RUNNER_PORT: '12345' };

async function withTempDir<T>(prefix: string, fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeRedirectPaths(root: string): RedirectPaths {
  const xctestDeviceSetPath = path.join(root, 'Library', 'Developer', 'XCTestDevices');
  return {
    requestedSetPath: path.join(root, 'requested'),
    xctestDeviceSetPath,
    lockDirPath: path.join(root, '.agent-device', 'xctest-device-set.lock'),
    backupPath: `${xctestDeviceSetPath}.agent-device-backup`,
  };
}

function makeScopedSimulator(paths: RedirectPaths): DeviceInfo {
  return { ...iosSimulator, simulatorSetPath: paths.requestedSetPath };
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function acquireRedirect(
  paths: RedirectPaths,
  options: Partial<Parameters<typeof acquireXcodebuildSimulatorSetRedirect>[1]> = {},
): ReturnType<typeof acquireXcodebuildSimulatorSetRedirect> {
  return await acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
    lockDirPath: paths.lockDirPath,
    xctestDeviceSetPath: paths.xctestDeviceSetPath,
    ...options,
  });
}

async function prepareXctestrunJson(
  xctestrunPath: string,
  envVars: Record<string, string>,
  suffix: string,
): Promise<Record<string, any>> {
  const prepared = await withCommandExecutorOverride(
    (cmd, args) => {
      if (cmd !== 'plutil') return undefined;
      if (args[0] === '-convert' && args[1] === 'json' && args[2] === '-o' && args[3] === '-') {
        return Promise.resolve({
          stdout: fs.readFileSync(String(args[4]), 'utf8'),
          stderr: '',
          exitCode: 0,
        });
      }
      if (args[0] === '-convert' && args[1] === 'xml1' && args[2] === '-o') {
        fs.copyFileSync(String(args[4]), String(args[3]));
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({
        stdout: '',
        stderr: `unexpected plutil args: ${args.join(' ')}`,
        exitCode: 1,
      });
    },
    () => prepareXctestrunWithEnv(xctestrunPath, envVars, suffix),
  );
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

function assertRedirectTargetsRequestedSet(paths: RedirectPaths): void {
  assert.equal(
    fs.realpathSync.native(paths.xctestDeviceSetPath),
    fs.realpathSync.native(paths.requestedSetPath),
  );
}

test('findXctestrun prefers simulator xctestrun over newer macos candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-xctestrun-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-xctestrun-'));
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
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(derivedRoot, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"version":"0.19.0"}\n');
    fs.writeFileSync(
      path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'Runner.swift'),
      'final class Runner {}\n',
    );
    writeExecutable(
      path.join(binDir, 'xcodebuild'),
      ['#!/bin/sh', 'printf "Xcode 26.2\\nBuild version 17C52\\n"'].join('\n'),
    );
    writeExecutable(
      path.join(binDir, 'xcrun'),
      [
        '#!/bin/sh',
        'case "$*" in',
        '  *"--show-sdk-version"*) printf "26.2\\n" ;;',
        '  *"--show-sdk-build-version"*) printf "23C53\\n" ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;

    try {
      const { writeXcuitestCacheMetadata } = await import(
        `${pathToFileURL(scriptPath).href}?case=${Date.now()}`
      );
      writeXcuitestCacheMetadata(
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
    } finally {
      restoreEnvVar('PATH', previousPath);
    }
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

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, `${contents}\n`, { mode: 0o755 });
}

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

    const prepared = await withCommandExecutorOverride(
      (cmd, args) => {
        if (cmd !== 'plutil') return undefined;
        if (args[0] === '-convert' && args[1] === 'json' && args[2] === '-o' && args[3] === '-') {
          return Promise.resolve({
            stdout: fs.readFileSync(String(args[4]), 'utf8'),
            stderr: '',
            exitCode: 0,
          });
        }
        if (args[0] === '-convert' && args[1] === 'xml1' && args[2] === '-o') {
          fs.copyFileSync(String(args[4]), String(args[3]));
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({
          stdout: '',
          stderr: `unexpected plutil args: ${args.join(' ')}`,
          exitCode: 1,
        });
      },
      () =>
        prepareXctestrunWithEnv(xctestrunPath, runnerPortEnv, 'aws session', {
          iosXctestEnvDir: envDir,
        }),
    );

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

test('resolveXcodebuildSimulatorDeviceSetPath uses XCTestDevices under the user home', () => {
  assert.equal(
    resolveXcodebuildSimulatorDeviceSetPath('/tmp/agent-device-home'),
    '/tmp/agent-device-home/Library/Developer/XCTestDevices',
  );
});

test('acquireXcodebuildSimulatorSetRedirect swaps XCTestDevices to the requested simulator set', async () => {
  let handle: Awaited<ReturnType<typeof acquireXcodebuildSimulatorSetRedirect>> | null = null;
  await withTempDir('runner-xctestrun-redirect-', async (root) => {
    const paths = makeRedirectPaths(root);
    const originalMarkerPath = path.join(root, 'original-marker.txt');
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
    fs.writeFileSync(
      path.join(paths.xctestDeviceSetPath, 'original.txt'),
      originalMarkerPath,
      'utf8',
    );

    handle = await acquireRedirect(paths);

    assert.notEqual(handle, null);
    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), true);
    assertRedirectTargetsRequestedSet(paths);

    await handle?.release();
    handle = null;

    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isDirectory(), true);
    assert.equal(
      fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'original.txt'), 'utf8'),
      originalMarkerPath,
    );
  }).finally(async () => {
    await handle?.release();
  });
});

test('acquireXcodebuildSimulatorSetRedirect is a no-op for simulators without a scoped device set', async () => {
  const handle = await acquireXcodebuildSimulatorSetRedirect(iosSimulator);
  assert.equal(handle, null);
});

test('acquireXcodebuildSimulatorSetRedirect restores stale redirected XCTestDevices before applying a new one', async () => {
  let handle: Awaited<ReturnType<typeof acquireXcodebuildSimulatorSetRedirect>> | null = null;
  await withTempDir('runner-xctestrun-redirect-', async (root) => {
    const paths = makeRedirectPaths(root);
    const staleRequestedSetPath = path.join(root, 'stale-requested');
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(staleRequestedSetPath, { recursive: true });
    fs.mkdirSync(path.dirname(paths.xctestDeviceSetPath), { recursive: true });
    fs.mkdirSync(paths.backupPath, { recursive: true });
    fs.writeFileSync(path.join(paths.backupPath, 'original.txt'), 'restored', 'utf8');
    fs.symlinkSync(staleRequestedSetPath, paths.xctestDeviceSetPath, 'dir');

    handle = await acquireRedirect(paths, { backupPath: paths.backupPath });

    assert.notEqual(handle, null);
    assertRedirectTargetsRequestedSet(paths);

    await handle?.release();
    handle = null;

    assert.equal(fs.existsSync(paths.backupPath), false);
    assert.equal(
      fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'original.txt'), 'utf8'),
      'restored',
    );
  }).finally(async () => {
    await handle?.release();
  });
});

test('acquireXcodebuildSimulatorSetRedirect clears stale lock directories from dead owners', async () => {
  let handle: Awaited<ReturnType<typeof acquireXcodebuildSimulatorSetRedirect>> | null = null;
  await withTempDir('runner-xctestrun-redirect-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.lockDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(paths.lockDirPath, 'owner.json'),
      JSON.stringify({ pid: 999_999, startTime: null, acquiredAtMs: Date.now() - 60_000 }),
      'utf8',
    );

    handle = await acquireRedirect(paths);

    assert.notEqual(handle, null);
    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), true);

    await handle?.release();
    handle = null;

    assert.equal(fs.existsSync(paths.lockDirPath), false);
  }).finally(async () => {
    await handle?.release();
  });
});

test('acquireXcodebuildSimulatorSetRedirect preserves the backup when XCTestDevices is recreated mid-swap', async () => {
  const renameSync = fs.renameSync.bind(fs);
  let xctestDeviceSetPath = '';
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (
      typeof oldPath === 'string' &&
      typeof newPath === 'string' &&
      newPath === xctestDeviceSetPath &&
      oldPath.includes('.agent-device-link-')
    ) {
      fs.mkdirSync(xctestDeviceSetPath, { recursive: true });
      fs.writeFileSync(path.join(xctestDeviceSetPath, 'collision.txt'), 'collision', 'utf8');
    }
    return renameSync(oldPath, newPath);
  });
  try {
    await withTempDir('runner-xctestrun-redirect-', async (root) => {
      const paths = makeRedirectPaths(root);
      xctestDeviceSetPath = paths.xctestDeviceSetPath;
      fs.mkdirSync(paths.requestedSetPath, { recursive: true });
      fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
      fs.writeFileSync(path.join(paths.xctestDeviceSetPath, 'original.txt'), 'original', 'utf8');

      await assert.rejects(
        acquireRedirect(paths, { backupPath: paths.backupPath }),
        /Failed to redirect XCTest device set path/,
      );

      assert.equal(
        fs.readFileSync(path.join(paths.backupPath, 'original.txt'), 'utf8'),
        'original',
      );
      assert.equal(
        fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'collision.txt'), 'utf8'),
        'collision',
      );
    });
  } finally {
    renameSpy.mockRestore();
  }
});
