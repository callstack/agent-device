import { test, vi, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- mirrors production's os.tmpdir xctestrun path
import os from 'node:os';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  buildRunnerSessionXctestrunPathCleanupPattern,
  buildRunnerSessionXctestrunSuffix,
} from '../runner-artifact-env.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';

// The toolchain probes reach the exec layer through `execFileSync`, which the package's host
// seam does not wrap; the module mock keeps a test from shelling out to a real Xcode.
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
import { evaluateExistingXctestrun } from '../runner-cache.ts';
import type { RunnerXctestrunCacheArtifacts } from '../runner-cache-metadata.ts';
import {
  ensureXctestrunArtifact,
  markRunnerXctestrunArtifactBadForRun,
  prepareXctestrunWithEnv,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
} from '../runner-xctestrun.ts';

const repoRoot = process.cwd();

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

/**
 * The build script and the metadata writer are separate processes with one contract: the recipe
 * `xcuitest-build-settings.ts` hands `xcodebuild` is the recipe the published identity records,
 * and the manifest certifies the bytes that build left on disk. Both scripts are driven the way
 * `build-xcuitest-apple.sh` drives them — real processes, a stand-in toolchain on PATH, and a
 * build log echoing the settings it was handed — because the scripts import the composition
 * root, which cannot share a process with this suite's test host.
 */
test('the build script and the metadata writer publish one iOS simulator identity', async () => {
  await withTempDir('runner-cache-metadata-', async (root) => {
    const project = seedRunnerBuildFixture(root);
    const buildSettings = runBuildSettings(project);
    fs.writeFileSync(project.buildLogPath, xcodebuildLogWithBuildSettings(buildSettings));

    const written = runScript(project.root, 'write-xcuitest-cache-metadata.ts', [
      'ios',
      project.derivedPath,
      project.destination,
      project.buildLogPath,
      project.bin,
    ]);
    assert.equal(written.status, 0, written.stderr);

    const published = readRunnerCacheManifest(project.derivedPath);
    const { artifacts: _artifacts, ...publishedIdentity } = published;
    assert.deepEqual(
      stripVolatile(publishedIdentity),
      stripVolatile(resolveExpectedRunnerCacheMetadata(iosSimulator, project.root)),
    );

    assert.ok(artifactsOf(published).xctestrunDigest);
    const entries = new Map(
      artifactsOf(published).entries.map((entry: any) => [entry.path, entry]),
    );
    const executableEntry = entries.get(
      path.relative(project.derivedPath, project.executablePath).replaceAll(path.sep, '/'),
    );
    assert.ok(executableEntry, 'the manifest must list the runner executable');
    assert.equal(executableEntry!.mode, 0o755);
    assert.equal(
      executableEntry!.digest,
      crypto.createHash('sha256').update(fs.readFileSync(project.executablePath)).digest('hex'),
    );

    // What the daemon will do with a restored tree: the manifest it just read must certify it.
    const state = await evaluateExistingXctestrun({
      derived: project.derivedPath,
      expectedCacheMetadata: resolveExpectedRunnerCacheMetadata(iosSimulator, project.root),
    });
    assert.equal(state.reason, 'reuse_ready');

    // The same files must keep reporting one fingerprint while only ignored sources change.
    fs.writeFileSync(project.ignoredSharedSource, 'ignored-two\n');
    assert.equal(
      resolveExpectedRunnerCacheMetadata(iosSimulator, project.root).runnerSourceFingerprint,
      published.runnerSourceFingerprint,
    );
    fs.writeFileSync(project.runnerUnitTest, 'unit-two\n');
    assert.notEqual(
      resolveExpectedRunnerCacheMetadata(iosSimulator, project.root).runnerSourceFingerprint,
      published.runnerSourceFingerprint,
    );
  });
}, 120_000);

test('the metadata writer refuses a build log whose recipe it did not record', async () => {
  await withTempDir('runner-cache-metadata-', async (root) => {
    const project = seedRunnerBuildFixture(root);
    const drifted = runBuildSettings(project).filter(
      (setting) => !setting.startsWith('ONLY_ACTIVE_ARCH='),
    );
    fs.writeFileSync(project.buildLogPath, xcodebuildLogWithBuildSettings(drifted));

    const written = runScript(project.root, 'write-xcuitest-cache-metadata.ts', [
      'ios',
      project.derivedPath,
      project.destination,
      project.buildLogPath,
      project.bin,
    ]);
    assert.notEqual(written.status, 0);
    assert.match(written.stderr, /did not use the settings its cache identity records/);
    assert.equal(
      fs.existsSync(path.join(project.derivedPath, '.agent-device-runner-cache.json')),
      false,
    );
  });
}, 120_000);

type RunnerBuildFixture = {
  root: string;
  bin: string;
  derivedPath: string;
  buildLogPath: string;
  destination: string;
  executablePath: string;
  runnerUnitTest: string;
  ignoredSharedSource: string;
};

/**
 * A project root plus the DerivedData a successful `build-for-testing` would leave behind:
 * an `.xctestrun` naming a product bundle whose executable is on disk.
 */
function seedRunnerBuildFixture(root: string): RunnerBuildFixture {
  const projectRoot = path.join(root, 'project');
  const derivedPath = path.join(root, 'derived');
  const productsRoot = path.join(derivedPath, 'Build', 'Products');
  const runnerAppPath = path.join(productsRoot, 'Debug-iphonesimulator', 'Runner-Runner.app');
  const executablePath = path.join(runnerAppPath, 'Runner');
  const xctestrunPath = path.join(
    productsRoot,
    'AgentDeviceRunner_AgentDeviceRunnerUITests_iphonesimulator26.2-arm64.xctestrun',
  );
  fs.mkdirSync(runnerAppPath, { recursive: true });
  fs.writeFileSync(executablePath, Buffer.from('runner-executable\n'), { mode: 0o755 });
  fs.mkdirSync(path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner'), { recursive: true });
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
  fs.writeFileSync(
    xctestrunPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRootHint</key>
  <string>${projectRoot}</string>
  <key>ProductPaths</key>
  <array>
    <string>__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app</string>
  </array>
</dict>
</plist>`,
  );
  const buildLogPath = path.join(derivedPath, 'Logs', 'agent-device-build-for-testing.log');
  fs.mkdirSync(path.dirname(buildLogPath), { recursive: true });
  return {
    root: projectRoot,
    bin: fakeAppleToolchainBin(root),
    derivedPath,
    buildLogPath,
    destination: 'generic/platform=iOS Simulator',
    executablePath,
    runnerUnitTest,
    ignoredSharedSource,
  };
}

/**
 * The three tools the scripts exec: `xcodebuild -version` and two `xcrun --sdk` probes, answering
 * exactly what this suite's fingerprint stub reports so the child and parent identities agree.
 */
function fakeAppleToolchainBin(root: string): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  writeFakeTool(
    bin,
    'xcodebuild',
    String.raw`{ printf 'Xcode 26.2
'; printf 'Build version 17C52
'; }`,
  );
  writeFakeTool(
    bin,
    'xcrun',
    String.raw`{ for arg in "$@"; do
  if [ "$arg" = "--show-sdk-build-version" ]; then printf "23C53
"; exit 0; fi
done
printf "26.2
"; }`,
  );
  return bin;
}

function writeFakeTool(bin: string, name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  fs.chmodSync(path.join(bin, name), 0o755);
}

/** The recipe the emitter hands `xcodebuild`, read the way the build script reads it. */
function runBuildSettings(project: RunnerBuildFixture): string[] {
  const emitted = runScript(project.root, 'xcuitest-build-settings.ts', [
    'ios',
    project.destination,
    project.bin,
  ]);
  assert.equal(emitted.status, 0, emitted.stderr);
  return emitted.stdout.split('\n').filter((line: string) => line !== '');
}

/** Runs one repository script in a real process, the way the build script does. */
function runScript(
  cwd: string,
  script: string,
  args: readonly string[],
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const fakeBin = args.at(-1)!;
  const rest = args.slice(0, -1);
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', path.join(repoRoot, 'scripts', script), ...rest],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
    },
  );
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * `xcodebuild`'s own echo of the recipe it was handed: build settings under their own header,
 * and the `-I` flags it does not treat as settings on the invocation line.
 */
function xcodebuildLogWithBuildSettings(settings: readonly string[]): string {
  const isSetting = (setting: string) => /^[A-Z][A-Z0-9_]*=/.test(setting);
  const buildSettings = settings.filter(isSetting).map((setting) => {
    const index = setting.indexOf('=');
    return `    ${setting.slice(0, index)} = ${setting.slice(index + 1)}`;
  });
  const flags = settings.filter((setting) => !isSetting(setting));
  return [
    'Command line invocation:',
    `    /usr/bin/xcodebuild build-for-testing ${flags.join(' ')}`.trimEnd(),
    '',
    'Build settings from command line:',
    ...buildSettings,
    '',
    'Resolve Package Graph',
    '',
  ].join('\n');
}

function readRunnerCacheManifest(derivedPath: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(derivedPath, '.agent-device-runner-cache.json'), 'utf8'),
  );
}

function artifactsOf(manifest: any): RunnerXctestrunCacheArtifacts {
  if (!manifest.artifacts) {
    throw new Error('The writer must publish an artifact manifest alongside the identity.');
  }
  return manifest.artifacts as RunnerXctestrunCacheArtifacts;
}

function stripVolatile(metadata: Record<string, unknown>): Record<string, unknown> {
  const { packageVersion: _packageVersion, ...rest } = metadata;
  return rest;
}

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
    // The lease-backed pattern is spelled from the path the writer returned, so pin those bytes
    // literally rather than comparing the pattern to the path it was built from: a rename that keeps
    // both sides self-consistent must still fail here.
    assert.equal(
      buildRunnerSessionXctestrunPathCleanupPattern(prepared.xctestrunPath),
      String.raw`AgentDeviceRunner\.env\.session-SIM-001-owner-4242-ab12cd34-8123\.xctestrun`,
    );
    assert.match(
      argv,
      new RegExp(
        String.raw`xcodebuild.*test-without-building.*AgentDeviceRunner\.env\.session-SIM-001-owner-4242-ab12cd34-8123\.xctestrun`,
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
