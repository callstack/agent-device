import { beforeEach, test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { mockRunCmdStreaming, mockRepairMacOsRunnerProductsIfNeeded } = vi.hoisted(() => ({
  mockRunCmdStreaming: vi.fn(),
  mockRepairMacOsRunnerProductsIfNeeded: vi.fn(),
}));

vi.mock('../../../utils/exec.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../../utils/exec.ts')>('../../../utils/exec.ts');
  return {
    ...actual,
    runCmdStreaming: mockRunCmdStreaming,
  };
});

vi.mock('../runner-macos-products.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-macos-products.ts')>(
    '../runner-macos-products.ts',
  );
  return {
    ...actual,
    repairMacOsRunnerProductsIfNeeded: mockRepairMacOsRunnerProductsIfNeeded,
  };
});

import type { DeviceInfo } from '../../../utils/device.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../../../utils/diagnostics.ts';
import { AppError } from '../../../utils/errors.ts';
import type { RunnerCommand } from '../runner-contract.ts';
import { isReadOnlyRunnerCommand, withRunnerCommandId } from '../runner-contract.ts';
import {
  assertSafeDerivedCleanup,
  isRetryableRunnerError,
  resolveRunnerBuildFailureHint,
  resolveRunnerEarlyExitHint,
  resolveRunnerBuildDestination,
  resolveRunnerBundleBuildSettings,
  resolveRunnerDestination,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerSigningBuildSettings,
  shouldRetryRunnerConnectError,
} from '../runner-client.ts';
import {
  acquireRunnerXctestrunCacheLock,
  ensureXctestrunArtifact,
  ensureXctestrun,
  markRunnerXctestrunArtifactBadForRun,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
  resolveRunnerCacheMetadataPath,
  resolveRunnerPerformanceBuildSettings,
  shouldDeleteRunnerDerivedRootEntry,
  writeRunnerCacheMetadata,
  xctestrunReferencesProjectRoot,
} from '../runner-xctestrun.ts';
import { parseRunnerResponse } from '../runner-session.ts';

const iosSimulator: DeviceInfo = {
  platform: 'ios',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

const iosDevice: DeviceInfo = {
  platform: 'ios',
  id: '00008110-000E12341234002E',
  name: 'iPhone',
  kind: 'device',
  booted: true,
};

const tvOsSimulator: DeviceInfo = {
  platform: 'ios',
  id: 'tv-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
  booted: true,
};

const tvOsDevice: DeviceInfo = {
  platform: 'ios',
  id: '00008120-000E12341234003F',
  name: 'Apple TV',
  kind: 'device',
  target: 'tv',
  booted: true,
};

const macOsDevice: DeviceInfo = {
  platform: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const runnerProtocolCommandFixtures: Record<RunnerCommand['command'], RunnerCommand> = {
  tap: { command: 'tap', x: 120, y: 240 },
  mouseClick: { command: 'mouseClick', x: 120, y: 240, button: 'secondary' },
  longPress: { command: 'longPress', x: 120, y: 240, durationMs: 750 },
  drag: { command: 'drag', x: 120, y: 240, x2: 300, y2: 420, durationMs: 400 },
  remotePress: { command: 'remotePress', remoteButton: 'down', durationMs: 250 },
  type: { command: 'type', text: 'hello', delayMs: 20, textEntryMode: 'replace' },
  swipe: { command: 'swipe', direction: 'down', durationMs: 250 },
  scroll: { command: 'scroll', direction: 'down', amount: 0.6, pixels: 240 },
  findText: { command: 'findText', text: 'Settings' },
  querySelector: { command: 'querySelector', selectorKey: 'id', selectorValue: 'submit' },
  readText: { command: 'readText' },
  snapshot: {
    command: 'snapshot',
    interactiveOnly: true,
    depth: 2,
    scope: 'app',
    raw: false,
  },
  screenshot: { command: 'screenshot', outPath: '/tmp/runner-screenshot.png', fullscreen: true },
  back: { command: 'back' },
  backInApp: { command: 'backInApp' },
  backSystem: { command: 'backSystem' },
  home: { command: 'home' },
  rotate: { command: 'rotate', orientation: 'landscape-left' },
  appSwitcher: { command: 'appSwitcher' },
  keyboardDismiss: { command: 'keyboardDismiss' },
  keyboardReturn: { command: 'keyboardReturn' },
  alert: { command: 'alert', action: 'accept' },
  pinch: { command: 'pinch', scale: 0.5 },
  sequence: {
    command: 'sequence',
    steps: [
      { kind: 'tap', x: 120, y: 240 },
      { kind: 'longPress', x: 120, y: 240, durationMs: 300 },
      { kind: 'drag', x: 10, y: 600, x2: 10, y2: 200, durationMs: 250, pauseMs: 50 },
    ],
  },
  rotateGesture: { command: 'rotateGesture', degrees: 35, x: 200, y: 420, velocity: 1 },
  transformGesture: {
    command: 'transformGesture',
    x: 200,
    y: 420,
    dx: 80,
    dy: -40,
    scale: 2,
    degrees: 35,
    durationMs: 700,
  },
  recordStart: {
    command: 'recordStart',
    outPath: '/tmp/runner-recording.mp4',
    fps: 30,
    maxSize: 720,
  },
  recordStop: { command: 'recordStop' },
  status: { command: 'status', statusCommandId: 'runner-command-1' },
  uptime: { command: 'uptime' },
  shutdown: { command: 'shutdown' },
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

async function makeTmpDir(): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctestrun-'));
  onTestFinished(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });
  return tmpDir;
}

async function makeProjectTmpDir(): Promise<string> {
  const tmpRoot = path.join(repoRoot, '.tmp');
  await fs.promises.mkdir(tmpRoot, { recursive: true });
  const tmpDir = await fs.promises.mkdtemp(path.join(tmpRoot, 'agent-device-xctestrun-'));
  onTestFinished(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });
  return tmpDir;
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function writeXctestrunFixture(
  xctestrunPath: string,
  options: { projectRoot: string; productRelativePaths: string[] },
): void {
  const entries = options.productRelativePaths
    .map((relativePath) => `        <string>__TESTROOT__/${relativePath}</string>`)
    .join('\n');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(
    xctestrunPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRootHint</key>
  <string>${options.projectRoot}</string>
  <key>ProductPaths</key>
  <array>
${entries}
  </array>
</dict>
</plist>`,
    'utf8',
  );
}

function withRunnerDerivedPathEnv(derivedPath: string): void {
  const previousDerivedPath = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derivedPath;
  onTestFinished(() => {
    restoreEnvVar('AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH', previousDerivedPath);
  });
}

function withoutRunnerDerivedPathEnv(): void {
  const previousDerivedPath = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  onTestFinished(() => {
    restoreEnvVar('AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH', previousDerivedPath);
  });
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function stripRunnerCacheArtifacts(metadata: Record<string, unknown>): Record<string, unknown> {
  const { artifacts: _artifacts, ...rest } = metadata;
  return rest;
}

function writeRunnerCacheMetadataWithArtifacts(params: {
  derivedPath: string;
  device: DeviceInfo;
  xctestrunPath: string;
  productPaths: string[];
}): void {
  fs.writeFileSync(
    resolveRunnerCacheMetadataPath(params.derivedPath),
    JSON.stringify(
      {
        ...resolveExpectedRunnerCacheMetadata(params.device, repoRoot),
        artifacts: {
          xctestrunPath: params.xctestrunPath,
          xctestrunMtimeMs: Math.trunc(fs.statSync(params.xctestrunPath).mtimeMs),
          xctestrunSize: fs.statSync(params.xctestrunPath).size,
          productPaths: params.productPaths.map((productPath) => ({
            path: productPath,
            mtimeMs: Math.trunc(fs.statSync(productPath).mtimeMs),
            size: fs.statSync(productPath).size,
          })),
        },
      },
      null,
      2,
    ),
  );
}

async function makeCachedRunnerXctestrun(): Promise<{
  derivedPath: string;
  existingXctestrunPath: string;
}> {
  const tmpDir = await makeProjectTmpDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const existingXctestrunPath = path.join(derivedPath, 'existing.xctestrun');
  await fs.promises.mkdir(derivedPath, { recursive: true });
  await fs.promises.mkdir(path.join(derivedPath, 'Runner.app'), { recursive: true });
  writeXctestrunFixture(existingXctestrunPath, {
    projectRoot: repoRoot,
    productRelativePaths: ['Runner.app'],
  });
  writeRunnerCacheMetadata(derivedPath, resolveExpectedRunnerCacheMetadata(macOsDevice, repoRoot));
  return { derivedPath, existingXctestrunPath };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmdStreaming.mockResolvedValue(undefined);
  mockRepairMacOsRunnerProductsIfNeeded.mockResolvedValue(undefined);
});

test('resolveRunnerDestination uses simulator destination for simulators', () => {
  assert.equal(resolveRunnerDestination(iosSimulator), 'platform=iOS Simulator,id=sim-1');
});

test('runner protocol fixtures cover every runner command with JSON-safe samples', () => {
  const commands = Object.keys(runnerProtocolCommandFixtures).sort();
  assert.deepEqual(commands, [
    'alert',
    'appSwitcher',
    'back',
    'backInApp',
    'backSystem',
    'drag',
    'findText',
    'home',
    'keyboardDismiss',
    'keyboardReturn',
    'longPress',
    'mouseClick',
    'pinch',
    'querySelector',
    'readText',
    'recordStart',
    'recordStop',
    'remotePress',
    'rotate',
    'rotateGesture',
    'screenshot',
    'scroll',
    'sequence',
    'shutdown',
    'snapshot',
    'status',
    'swipe',
    'tap',
    'transformGesture',
    'type',
    'uptime',
  ]);

  const roundTrip = JSON.parse(JSON.stringify(runnerProtocolCommandFixtures)) as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(roundTrip.tap!.command, 'tap');
  assert.equal(roundTrip.mouseClick!.button, 'secondary');
  assert.equal(roundTrip.snapshot!.scope, 'app');
  assert.equal(roundTrip.screenshot!.fullscreen, true);
  assert.equal(roundTrip.rotate!.orientation, 'landscape-left');
  assert.equal(roundTrip.recordStart!.fps, 30);
  assert.equal(roundTrip.recordStart!.maxSize, 720);
});

test('withRunnerCommandId replaces blank command ids', () => {
  const command = withRunnerCommandId({ command: 'uptime', commandId: '   ' });

  assert.match(command.commandId ?? '', /^runner-/);
});

test('withRunnerCommandId preserves existing command ids', () => {
  const command = withRunnerCommandId({ command: 'uptime', commandId: 'runner-existing' });

  assert.deepEqual(command, { command: 'uptime', commandId: 'runner-existing' });
});

test('scroll is a mutating, command-id-tracked runner command', () => {
  // Omission from isReadOnlyRunnerCommand classifies the fused scroll as mutating, routing it
  // through single-send (no transport retry), command-id tracking, and status recovery.
  assert.equal(isReadOnlyRunnerCommand('scroll'), false);

  const command = withRunnerCommandId({ command: 'scroll', direction: 'down', pixels: 120 });
  assert.match(command.commandId ?? '', /^runner-/);
});

test('withRunnerCommandId does not add command ids to status probes', () => {
  const command = withRunnerCommandId({
    command: 'status',
    statusCommandId: 'runner-command-1',
  });

  assert.deepEqual(command, { command: 'status', statusCommandId: 'runner-command-1' });
});

test('resolveRunnerDestination uses device destination for physical devices', () => {
  assert.equal(resolveRunnerDestination(iosDevice), 'platform=iOS,id=00008110-000E12341234002E');
});

test('resolveRunnerBuildDestination uses generic iOS destination for physical devices', () => {
  assert.equal(resolveRunnerBuildDestination(iosDevice), 'generic/platform=iOS');
});

test('resolveRunnerDestination uses tvOS simulator destination for tvOS simulators', () => {
  assert.equal(resolveRunnerDestination(tvOsSimulator), 'platform=tvOS Simulator,id=tv-sim-1');
});

test('resolveRunnerDestination uses tvOS destination for tvOS devices', () => {
  assert.equal(resolveRunnerDestination(tvOsDevice), 'platform=tvOS,id=00008120-000E12341234003F');
});

test('resolveRunnerBuildDestination uses tvOS destinations for tvOS devices and simulators', () => {
  assert.equal(resolveRunnerBuildDestination(tvOsSimulator), 'platform=tvOS Simulator,id=tv-sim-1');
  assert.equal(resolveRunnerBuildDestination(tvOsDevice), 'generic/platform=tvOS');
});

test('resolveRunnerMaxConcurrentDestinationsFlag uses simulator flag for simulators', () => {
  assert.equal(
    resolveRunnerMaxConcurrentDestinationsFlag(iosSimulator),
    '-maximum-concurrent-test-simulator-destinations',
  );
});

test('resolveRunnerMaxConcurrentDestinationsFlag uses device flag for physical devices', () => {
  assert.equal(
    resolveRunnerMaxConcurrentDestinationsFlag(iosDevice),
    '-maximum-concurrent-test-device-destinations',
  );
});

test('resolveRunnerMaxConcurrentDestinationsFlag uses device flag for macOS desktop', () => {
  assert.equal(
    resolveRunnerMaxConcurrentDestinationsFlag(macOsDevice),
    '-maximum-concurrent-test-device-destinations',
  );
});

test('resolveRunnerSigningBuildSettings returns empty args without env overrides', () => {
  assert.deepEqual(resolveRunnerSigningBuildSettings({}), []);
});

test('resolveRunnerSigningBuildSettings disables signing for macOS desktop builds', () => {
  assert.deepEqual(resolveRunnerSigningBuildSettings({}, true, 'macos'), [
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=',
    'DEVELOPMENT_TEAM=',
  ]);
});

test('resolveRunnerSigningBuildSettings enables automatic signing for device builds without forcing identity', () => {
  assert.deepEqual(resolveRunnerSigningBuildSettings({}, true), ['CODE_SIGN_STYLE=Automatic']);
});

test('resolveRunnerSigningBuildSettings ignores device signing overrides for simulator builds', () => {
  assert.deepEqual(
    resolveRunnerSigningBuildSettings(
      {
        AGENT_DEVICE_IOS_TEAM_ID: 'ABCDE12345',
        AGENT_DEVICE_IOS_SIGNING_IDENTITY: 'Apple Development',
        AGENT_DEVICE_IOS_PROVISIONING_PROFILE: 'My Profile',
      },
      false,
    ),
    [],
  );
});

test('resolveRunnerSigningBuildSettings applies optional overrides when provided', () => {
  const settings = resolveRunnerSigningBuildSettings(
    {
      AGENT_DEVICE_IOS_TEAM_ID: 'ABCDE12345',
      AGENT_DEVICE_IOS_SIGNING_IDENTITY: 'Apple Development',
      AGENT_DEVICE_IOS_PROVISIONING_PROFILE: 'My Profile',
    },
    true,
  );
  assert.deepEqual(settings, [
    'CODE_SIGN_STYLE=Automatic',
    'DEVELOPMENT_TEAM=ABCDE12345',
    'CODE_SIGN_IDENTITY=Apple Development',
    'PROVISIONING_PROFILE_SPECIFIER=My Profile',
  ]);
});

test('resolveRunnerPerformanceBuildSettings disables indexing and code coverage', () => {
  assert.deepEqual(resolveRunnerPerformanceBuildSettings(), [
    'COMPILER_INDEX_STORE_ENABLE=NO',
    'ENABLE_CODE_COVERAGE=NO',
  ]);
});

test('resolveRunnerBundleBuildSettings returns default bundle identifiers', () => {
  assert.deepEqual(resolveRunnerBundleBuildSettings({}), [
    'AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=com.callstack.agentdevice.runner',
    'AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.callstack.agentdevice.runner.uitests',
  ]);
});

test('resolveRunnerBundleBuildSettings uses AGENT_DEVICE_IOS_BUNDLE_ID when provided', () => {
  assert.deepEqual(
    resolveRunnerBundleBuildSettings({
      AGENT_DEVICE_IOS_BUNDLE_ID: 'com.example.agent-device.runner',
    }),
    [
      'AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=com.example.agent-device.runner',
      'AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.example.agent-device.runner.uitests',
    ],
  );
});

test('assertSafeDerivedCleanup allows cleaning when no override is set', () => {
  assert.doesNotThrow(() => {
    assertSafeDerivedCleanup('/tmp/derived', {});
  });
});

test('assertSafeDerivedCleanup rejects cleaning override path by default', () => {
  assert.throws(() => {
    assertSafeDerivedCleanup('/tmp/custom', {
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: '/tmp/custom',
    });
  }, /Refusing to clean AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH automatically/);
});

test('assertSafeDerivedCleanup allows cleaning override path under project .tmp', () => {
  const derivedPath = path.join(repoRoot, '.tmp', 'ios-runner-derived');
  assert.doesNotThrow(() => {
    assertSafeDerivedCleanup(derivedPath, {
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: derivedPath,
    });
  });
});

test('resolveRunnerEarlyExitHint surfaces busy-connecting guidance', () => {
  const hint = resolveRunnerEarlyExitHint(
    'Runner did not accept connection (xcodebuild exited early)',
    'Ineligible destinations for the "AgentDeviceRunner" scheme:\n{ error:Device is busy (Connecting to iPhone) }',
    '',
  );
  assert.match(hint, /still connecting/i);
});

test('resolveRunnerEarlyExitHint falls back to runner connect timeout hint', () => {
  const hint = resolveRunnerEarlyExitHint(
    'Runner did not accept connection (xcodebuild exited early)',
    '',
    'xcodebuild failed unexpectedly',
  );
  assert.match(hint, /retry runner startup/i);
  assert.match(hint, /pnpm clean:xcuitest/i);
});

test('resolveRunnerBuildFailureHint suggests cache cleanup for non-signing failures', () => {
  const hint = resolveRunnerBuildFailureHint(
    new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed'),
  );

  assert.match(hint, /pnpm clean:xcuitest/i);
  assert.match(hint, /~\/\.agent-device\/ios-runner\/derived/i);
});

test('shouldRetryRunnerConnectError does not retry xcodebuild early-exit errors', () => {
  const err = new AppError(
    'COMMAND_FAILED',
    'Runner did not accept connection (xcodebuild exited early)',
  );
  assert.equal(shouldRetryRunnerConnectError(err), false);
});

test('shouldRetryRunnerConnectError retries transient connect errors', () => {
  const err = new AppError('COMMAND_FAILED', 'Runner endpoint probe failed');
  assert.equal(shouldRetryRunnerConnectError(err), true);
});

test('parseRunnerResponse preserves runner unsupported-operation codes', async () => {
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'Unable to dismiss the iOS keyboard without a native dismiss gesture or control',
      },
    }),
  );
  const session = { ready: false };

  await assert.rejects(
    () => parseRunnerResponse(response, session, '/tmp/runner.log'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.match(error.message, /Unable to dismiss the iOS keyboard/i);
      return true;
    },
  );
});

test('parseRunnerResponse preserves iOS AX snapshot failure code and hint', async () => {
  const hint =
    'Try a smaller read such as snapshot -s <visible label or id> -d 8, or use direct selector commands such as find id <value> click.';
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'IOS_AX_SNAPSHOT_FAILED',
        message: 'iOS XCTest snapshot failed with kAXErrorIllegalArgument.',
        hint,
      },
    }),
  );
  const session = { ready: true };

  await assert.rejects(
    () => parseRunnerResponse(response, session, '/tmp/runner.log'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'IOS_AX_SNAPSHOT_FAILED');
      assert.match(error.message, /kAXErrorIllegalArgument/);
      assert.equal(error.details?.hint, hint);
      assert.equal(isRetryableRunnerError(error), false);
      return true;
    },
  );
});

test('parseRunnerResponse preserves XCTest recorded failure code and hint', async () => {
  const hint = 'The iOS runner session will be restarted.';
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'XCTEST_RECORDED_FAILURE',
        message:
          'XCTest recorded a failure while executing tap; the action may not have been performed.',
        hint,
      },
    }),
  );
  const session = { ready: true };

  await assert.rejects(
    () => parseRunnerResponse(response, session, '/tmp/runner.log'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'XCTEST_RECORDED_FAILURE');
      assert.match(error.message, /may not have been performed/);
      assert.equal(error.details?.hint, hint);
      assert.equal(isRetryableRunnerError(error), false);
      return true;
    },
  );
});

test('parseRunnerResponse classifies target app AXRuntime CoreText font crashes from runner log tail', async () => {
  const logPath = writeRunnerLogTail(`
Thread 0 Crashed::  Dispatch queue: com.apple.main-thread
0   libobjc.A.dylib                        objc_retain + 16
1   CoreText                               CreateFontWithFontURL(__CFURL const*, __CFString const*, __CFString const*) + 512
11  AXRuntime                              reconstitutedSmuggledCTFontFromDictionary + 192
12  AXRuntime                              -[NSDictionary(AXPropertyListCoersion) _axRecursivelyReconstitutedRepresentationFromPropertyListWithError:] + 156
`);
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'XCTEST_RECORDED_FAILURE',
        message:
          'XCTest recorded a failure while executing type; the action may not have been performed.',
      },
    }),
  );
  const session = { ready: true };

  await assert.rejects(
    () => parseRunnerResponse(response, session, logPath),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'IOS_TARGET_APP_CRASH');
      assert.equal(error.details?.runnerFailureReason, 'target_app_axruntime_coretext_crash');
      assert.match(String(error.details?.hint), /AXRuntime read accessibility attributes/);
      assert.match(String(error.details?.hint), /latest stable simulator runtime/);
      assert.match(String(error.details?.hint), /exact command, selector\/ref/);
      return true;
    },
  );
});

test('parseRunnerResponse classifies explicit target app crashes from runner log tail', async () => {
  const logPath = writeRunnerLogTail(`
AGENT_DEVICE_RUNNER_COMMAND_FAILED command=snapshot
The application under test terminated unexpectedly.
`);
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'Runner error',
      },
    }),
  );
  const session = { ready: true };

  await assert.rejects(
    () => parseRunnerResponse(response, session, logPath),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'IOS_TARGET_APP_CRASH');
      assert.equal(error.details?.runnerFailureReason, 'target_app_crash');
      assert.match(String(error.details?.hint), /target iOS app appears to have crashed/);
      assert.equal(isRetryableRunnerError(error), false);
      return true;
    },
  );
});

test('parseRunnerResponse does not classify incidental XCTest crash text as target app crash', async () => {
  const logPath = writeRunnerLogTail(`
XCTest runner recovered from a previous test note: the word crashed appeared in debug output.
AGENT_DEVICE_RUNNER_COMMAND_FAILED command=snapshot error=fetch failed
`);
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'fetch failed',
      },
    }),
  );
  const session = { ready: true };

  await assert.rejects(
    () => parseRunnerResponse(response, session, logPath),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.runnerFailureReason, undefined);
      assert.equal(error.details?.hint, undefined);
      assert.equal(isRetryableRunnerError(error), true);
      return true;
    },
  );
});

test('parseRunnerResponse keeps ordinary runner failures generic without crash log evidence', async () => {
  const logPath = writeRunnerLogTail(
    'AGENT_DEVICE_RUNNER_COMMAND_FAILED command=type error=main thread execution timed out',
  );
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'main thread execution timed out',
      },
    }),
  );
  const session = { ready: true };

  await assert.rejects(
    () => parseRunnerResponse(response, session, logPath),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.runnerFailureReason, undefined);
      assert.equal(error.details?.hint, undefined);
      return true;
    },
  );
});

test('parseRunnerResponse emits diagnostics for runner gesture fallbacks', async () => {
  const response = new Response(
    JSON.stringify({
      ok: true,
      data: {
        message: 'dragged',
        gestureFallback: 'xctest-coordinate-drag',
        gestureFallbackMessage: 'Runner synthesized drag is unavailable',
        gestureFallbackHint: 'Using XCTest coordinate drag fallback.',
      },
    }),
  );
  const session = { ready: false };

  const diagnostics = await captureParseRunnerDiagnostics(async () => {
    const data = await parseRunnerResponse(response, session, '/tmp/runner.log');
    assert.equal(data.gestureFallback, 'xctest-coordinate-drag');
  });

  assert.equal(session.ready, true);
  assert.match(diagnostics, /ios_runner_gesture_fallback/);
  assert.match(diagnostics, /xctest-coordinate-drag/);
});

function writeRunnerLogTail(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runner-log-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'runner.log');
  fs.writeFileSync(logPath, contents);
  return logPath;
}

test('isRetryableRunnerError does not retry xcodebuild early-exit errors', () => {
  const err = new AppError(
    'COMMAND_FAILED',
    'Runner did not accept connection (xcodebuild exited early)',
  );
  assert.equal(isRetryableRunnerError(err), false);
});

async function captureParseRunnerDiagnostics(callback: () => Promise<void>): Promise<string> {
  const previousHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runner-parse-diag-'));
  try {
    return await withDiagnosticsScope(
      { session: 'runner-parse-test', requestId: 'request-1', command: 'drag' },
      async () => {
        await callback();
        const diagnosticsPath = flushDiagnosticsToSessionFile({ force: true });
        assert.ok(diagnosticsPath);
        return fs.readFileSync(diagnosticsPath, 'utf8');
      },
    );
  } finally {
    process.env.HOME = previousHome;
  }
}

test('isRetryableRunnerError does not retry busy-connecting errors', () => {
  const err = new AppError('COMMAND_FAILED', 'Device is busy (Connecting to iPhone)');
  assert.equal(isRetryableRunnerError(err), false);
});

test('xctestrunReferencesProjectRoot rejects stale worktree artifacts', async () => {
  const tmpDir = await makeTmpDir();
  const xctestrunPath = path.join(tmpDir, 'AgentDeviceRunner.xctestrun');
  fs.writeFileSync(
    xctestrunPath,
    '<plist><dict><key>SourceFilesCommonPathPrefix</key><string>/tmp/other-worktree/agent-device/ios-runner/AgentDeviceRunner</string></dict></plist>',
    'utf8',
  );

  assert.equal(
    xctestrunReferencesProjectRoot(xctestrunPath, '/tmp/current-worktree/agent-device'),
    false,
  );
  assert.equal(
    xctestrunReferencesProjectRoot(xctestrunPath, '/tmp/other-worktree/agent-device'),
    true,
  );
});

test('resolveRunnerDerivedPath keys default cache by runner metadata', () => {
  withoutRunnerDerivedPathEnv();
  const metadata = resolveExpectedRunnerCacheMetadata(iosSimulator, repoRoot);
  const iosPath = resolveRunnerDerivedPath(iosSimulator, metadata);
  const tvPath = resolveRunnerDerivedPath(tvOsSimulator, {
    ...metadata,
    platformName: 'tvOS',
    target: 'tv',
    buildDestinationFamily: 'appletvsimulator',
  });
  const macPath = resolveRunnerDerivedPath(macOsDevice, {
    ...metadata,
    platformName: 'macOS',
    target: 'desktop',
    buildDestinationFamily: 'macos',
  });
  const staleVersionPath = resolveRunnerDerivedPath(iosSimulator, {
    ...metadata,
    packageVersion: '0.0.0-stale',
  });

  assert.match(iosPath, /\/ios-runner\/derived\/ios-simulator\/cache-[a-f0-9]{16}$/);
  assert.match(tvPath, /\/ios-runner\/derived\/tvos-simulator\/cache-[a-f0-9]{16}$/);
  assert.match(macPath, /\/ios-runner\/derived\/macos\/cache-[a-f0-9]{16}$/);
  assert.notEqual(iosPath, staleVersionPath);
});

test('resolveRunnerDerivedPath reuses cache path for identical runner source fingerprints', async () => {
  withoutRunnerDerivedPathEnv();
  const tmpDir = await makeTmpDir();
  const firstRoot = path.join(tmpDir, 'first');
  const secondRoot = path.join(tmpDir, 'second');
  const runnerRelativePath = path.join(
    'ios-runner',
    'AgentDeviceRunner',
    'AgentDeviceRunnerUITests',
    'RunnerTests.swift',
  );
  await fs.promises.mkdir(path.dirname(path.join(firstRoot, runnerRelativePath)), {
    recursive: true,
  });
  await fs.promises.mkdir(path.dirname(path.join(secondRoot, runnerRelativePath)), {
    recursive: true,
  });
  await fs.promises.writeFile(
    path.join(firstRoot, runnerRelativePath),
    'final class RunnerTests {}\n',
  );
  await fs.promises.writeFile(
    path.join(secondRoot, runnerRelativePath),
    'final class RunnerTests {}\n',
  );

  const firstPath = resolveRunnerDerivedPath(
    iosSimulator,
    resolveExpectedRunnerCacheMetadata(iosSimulator, firstRoot),
  );
  const secondPath = resolveRunnerDerivedPath(
    iosSimulator,
    resolveExpectedRunnerCacheMetadata(iosSimulator, secondRoot),
  );
  await fs.promises.writeFile(
    path.join(secondRoot, runnerRelativePath),
    'final class RunnerTests { let changed = true }\n',
  );
  const changedPath = resolveRunnerDerivedPath(
    iosSimulator,
    resolveExpectedRunnerCacheMetadata(iosSimulator, secondRoot),
  );

  assert.equal(firstPath, secondPath);
  assert.notEqual(firstPath, changedPath);
});

test('acquireRunnerXctestrunCacheLock serializes cache access across acquirers', async () => {
  const tmpDir = await makeTmpDir();
  const derivedPath = path.join(tmpDir, 'derived');
  const releaseFirst = await acquireRunnerXctestrunCacheLock(derivedPath);
  let secondAcquired = false;
  const second = acquireRunnerXctestrunCacheLock(derivedPath).then(async (releaseSecond) => {
    secondAcquired = true;
    await releaseSecond();
  });

  await waitMs(50);
  assert.equal(secondAcquired, false);
  await releaseFirst();
  await second;
  assert.equal(secondAcquired, true);
});

test('ensureXctestrun reuses matching manifest artifacts from another project root', async () => {
  const tmpDir = await makeTmpDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const productPath = path.join(derivedPath, 'Runner.app');
  const xctestrunPath = path.join(derivedPath, 'manifest.xctestrun');
  await fs.promises.mkdir(productPath, { recursive: true });
  writeXctestrunFixture(xctestrunPath, {
    projectRoot: '/tmp/other-agent-device-worktree',
    productRelativePaths: ['Runner.app'],
  });
  writeRunnerCacheMetadataWithArtifacts({
    derivedPath,
    device: macOsDevice,
    xctestrunPath,
    productPaths: [productPath],
  });
  withRunnerDerivedPathEnv(derivedPath);

  const result = await ensureXctestrun(macOsDevice, {});

  assert.equal(result, xctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.deepEqual(mockRepairMacOsRunnerProductsIfNeeded.mock.calls[0]?.[1], [productPath]);
});

test('ensureXctestrun rebuilds foreign artifacts when metadata does not match', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectTmpDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const productPath = path.join(derivedPath, 'Runner.app');
  const foreignXctestrunPath = path.join(derivedPath, 'foreign.xctestrun');
  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');
  await fs.promises.mkdir(productPath, { recursive: true });
  writeXctestrunFixture(foreignXctestrunPath, {
    projectRoot: '/tmp/other-agent-device-worktree',
    productRelativePaths: ['Runner.app'],
  });
  writeRunnerCacheMetadataWithArtifacts({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: foreignXctestrunPath,
    productPaths: [productPath],
  });
  const metadataPath = resolveRunnerCacheMetadataPath(derivedPath);
  const staleMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  staleMetadata.packageVersion = '0.0.0-stale';
  fs.writeFileSync(metadataPath, JSON.stringify(staleMetadata, null, 2));
  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementation(async () => {
    await fs.promises.mkdir(path.join(derivedPath, 'rebuilt', 'Runner.app'), { recursive: true });
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = await ensureXctestrun(macOsDevice, {});

  assert.equal(result, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(fs.existsSync(foreignXctestrunPath), false);
});

test('ensureXctestrun ignores manifest artifacts outside the cache root', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectTmpDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const externalDir = path.join(tmpDir, 'external');
  const externalProductPath = path.join(externalDir, 'Runner.app');
  const externalXctestrunPath = path.join(externalDir, 'external.xctestrun');
  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');
  await fs.promises.mkdir(externalProductPath, { recursive: true });
  writeXctestrunFixture(externalXctestrunPath, {
    projectRoot,
    productRelativePaths: ['Runner.app'],
  });
  await fs.promises.mkdir(derivedPath, { recursive: true });
  writeRunnerCacheMetadataWithArtifacts({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: externalXctestrunPath,
    productPaths: [externalProductPath],
  });
  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementation(async () => {
    await fs.promises.mkdir(path.join(derivedPath, 'rebuilt', 'Runner.app'), { recursive: true });
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = await ensureXctestrun(macOsDevice, {});

  assert.equal(result, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
});

test('ensureXctestrun rebuilds after cached macOS runner repair failure', async () => {
  // Cached runner artifacts can look reusable until ad-hoc repair fails; ensure we clean once,
  // rebuild, and return the repaired rebuilt xctestrun instead of looping on stale cache state.
  const projectRoot = repoRoot;
  const { derivedPath, existingXctestrunPath } = await makeCachedRunnerXctestrun();
  const projectPath = path.join(
    projectRoot,
    'ios-runner',
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
    await fs.promises.mkdir(path.join(derivedPath, 'rebuilt', 'Runner.app'), { recursive: true });
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = await ensureXctestrun(macOsDevice, {});

  assert.equal(result, rebuiltXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(fs.existsSync(existingXctestrunPath), false);
  assert.deepEqual(repairedPaths, [existingXctestrunPath, rebuiltXctestrunPath]);
});

test('ensureXctestrun prefers validated cache manifest over recursive scan', async () => {
  const tmpDir = await makeTmpDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const manifestProductPath = path.join(derivedPath, 'ManifestRunner.app');
  const manifestXctestrunPath = path.join(derivedPath, 'manifest.xctestrun');
  const newerProductPath = path.join(derivedPath, 'NewerRunner.app');
  const newerXctestrunPath = path.join(derivedPath, 'newer.xctestrun');
  await fs.promises.mkdir(manifestProductPath, { recursive: true });
  await fs.promises.mkdir(newerProductPath, { recursive: true });
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
  writeRunnerCacheMetadataWithArtifacts({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: manifestXctestrunPath,
    productPaths: [manifestProductPath],
  });
  withRunnerDerivedPathEnv(derivedPath);

  const result = await ensureXctestrun(macOsDevice, {});

  assert.equal(result, manifestXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.deepEqual(mockRepairMacOsRunnerProductsIfNeeded.mock.calls[0]?.[1], [manifestProductPath]);
});

test('ensureXctestrun falls back to scan when cache manifest is stale', async () => {
  const tmpDir = await makeTmpDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const manifestProductPath = path.join(derivedPath, 'ManifestRunner.app');
  const manifestXctestrunPath = path.join(derivedPath, 'manifest.xctestrun');
  const newerProductPath = path.join(derivedPath, 'NewerRunner.app');
  const newerXctestrunPath = path.join(derivedPath, 'newer.xctestrun');
  await fs.promises.mkdir(manifestProductPath, { recursive: true });
  await fs.promises.mkdir(newerProductPath, { recursive: true });
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
  writeRunnerCacheMetadataWithArtifacts({
    derivedPath,
    device: macOsDevice,
    xctestrunPath: manifestXctestrunPath,
    productPaths: [manifestProductPath],
  });
  fs.utimesSync(
    manifestProductPath,
    new Date(now.getTime() + 10_000),
    new Date(now.getTime() + 10_000),
  );
  withRunnerDerivedPathEnv(derivedPath);

  const result = await ensureXctestrun(macOsDevice, {});

  assert.equal(result, newerXctestrunPath);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.deepEqual(mockRepairMacOsRunnerProductsIfNeeded.mock.calls[0]?.[1], [newerProductPath]);
});

test('ensureXctestrun rebuilds cached runner when metadata package version mismatches', async () => {
  const projectRoot = repoRoot;
  const { derivedPath, existingXctestrunPath } = await makeCachedRunnerXctestrun();
  const metadataPath = resolveRunnerCacheMetadataPath(derivedPath);
  const staleMetadata = {
    ...resolveExpectedRunnerCacheMetadata(macOsDevice, repoRoot),
    packageVersion: '0.0.0-stale',
  };
  fs.writeFileSync(metadataPath, JSON.stringify(staleMetadata, null, 2));

  const rebuiltXctestrunPath = path.join(derivedPath, 'rebuilt', 'rebuilt.xctestrun');

  withRunnerDerivedPathEnv(derivedPath);

  mockRunCmdStreaming.mockImplementation(async () => {
    await fs.promises.mkdir(path.join(derivedPath, 'rebuilt', 'Runner.app'), { recursive: true });
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const result = await ensureXctestrun(macOsDevice, {});

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

test('ensureXctestrunArtifact stress-recovers after a bad restored artifact', async () => {
  const projectRoot = repoRoot;
  const tmpDir = await makeProjectTmpDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const productPath = path.join(derivedPath, 'Runner.app');
  const cachedXctestrunPath = path.join(derivedPath, 'cached.xctestrun');
  await fs.promises.mkdir(productPath, { recursive: true });
  writeXctestrunFixture(cachedXctestrunPath, {
    projectRoot,
    productRelativePaths: ['Runner.app'],
  });
  writeRunnerCacheMetadataWithArtifacts({
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
    await fs.promises.mkdir(path.join(derivedPath, 'rebuilt', 'Runner.app'), { recursive: true });
    writeXctestrunFixture(rebuiltXctestrunPath, {
      projectRoot,
      productRelativePaths: ['Runner.app'],
    });
  });

  const rebuilt = await ensureXctestrunArtifact(macOsDevice, {
    buildTimeoutMs: 300_000,
  });

  assert.equal(rebuilt.xctestrunPath, rebuiltXctestrunPath);
  assert.equal(rebuilt.cache, 'miss');
  assert.equal(rebuilt.artifact, 'rebuilt');
  assert.equal(rebuilt.reason, 'missing_xctestrun');
  assert.equal(mockRunCmdStreaming.mock.calls.length, 1);
  assert.equal(mockRunCmdStreaming.mock.calls[0]?.[2]?.timeoutMs, 300_000);
});

test('ensureXctestrun rethrows unexpected cached macOS runner repair errors', async () => {
  const { derivedPath, existingXctestrunPath } = await makeCachedRunnerXctestrun();

  withRunnerDerivedPathEnv(derivedPath);

  mockRepairMacOsRunnerProductsIfNeeded.mockRejectedValue(new Error('permission denied'));

  await assert.rejects(ensureXctestrun(macOsDevice, {}), /permission denied/);
  assert.equal(mockRunCmdStreaming.mock.calls.length, 0);
  assert.equal(fs.existsSync(existingXctestrunPath), true);
});

test('shouldDeleteRunnerDerivedRootEntry only removes known xcode transient entries', () => {
  assert.equal(shouldDeleteRunnerDerivedRootEntry('Build'), true);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('Logs'), true);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('Index.noindex'), true);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('device'), false);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('macos'), false);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('visionos'), false);
});
