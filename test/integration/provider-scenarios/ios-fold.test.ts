import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import { MAX_FOLD_DURATION_MS } from '@agent-device/contracts/device';
import type { AppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import type { ExecResult } from '@agent-device/host-kit/command';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { normalizeError } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { sendRequest } from '../../../src/daemon-client/daemon-client-transport.ts';
import { setTimeout as realSleep } from 'node:timers/promises';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProviderScenarioHarness, type ProviderScenarioRpcResult } from './harness.ts';
import { createRecordingAppleToolProvider } from './providers.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';

// The fold helper's build cache lives under the host home directory (#2796), so this test scopes
// HOME to a throwaway directory: otherwise it would read and write the real developer/CI machine's
// `~/.agent-device/fold-helper` cache and the `builds` assertion below would depend on whatever that
// machine's cache already held.
let previousHome: string | undefined;
let isolatedHome: string;

beforeEach(() => {
  previousHome = process.env.HOME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-fold-home-'));
  process.env.HOME = isolatedHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

/** Writes the `devicectl … displays --json-output <path>` result both fold fakes below answer. */
function writeDisplayInventoryFixture(jsonOutputPath: string): void {
  const displays = [0, 1].map((displayId) => ({
    name: `LCD-${displayId}`,
    displayId,
    nativeSize: [2007, 2853],
    pointScale: 3,
    type: { integrated: {} },
    active: displayId === 1,
  }));
  fs.writeFileSync(jsonOutputPath, JSON.stringify({ result: { displays } }));
}

/**
 * Answers the host-toolchain probe (`xcodebuild -version`, `sw_vers`) the fold-helper
 * build cache (`fold-helper-cache.ts`) reads before it builds or reuses a cached binary. Both fold
 * fakes below route these calls through the same `runCommand`.
 */
function toolchainProbeAnswer(cmd: string, args: readonly string[]): ExecResult | undefined {
  if (cmd === 'xcodebuild')
    return { stdout: 'Xcode 16.4\nBuild version 16F6', stderr: '', exitCode: 0 };
  if (cmd === 'sw_vers') {
    return {
      stdout: args.includes('-buildVersion') ? '24G90' : '15.6',
      stderr: '',
      exitCode: 0,
    };
  }
  return undefined;
}

test('timed fold keyframes reach simulator HID through the public client and daemon', async () => {
  const trajectory = [
    { atMs: 0, angle: 0 },
    { atMs: 5000, angle: 100 },
  ];
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  let angle = 0;
  const tool = createRecordingAppleToolProvider({
    simctl: async (args, options) => {
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            devices: {
              'iOS 18.5': [{ udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id, state: 'Booted' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'launch') return ok;
      assert.equal(args[0], 'spawn');
      assert.equal(args[1], PROVIDER_SCENARIO_IOS_SIMULATOR.id);
      assert.deepEqual(JSON.parse(args[3]!), trajectory);
      assert.equal(options?.timeoutMs, 15000);
      angle = 100;
      return ok;
    },
    devicectl: async (args) => {
      if (args.includes('hinge-angle')) return { ...ok, stdout: `Angle: ${angle}°`, exitCode: 1 };
      assert.ok(args.includes('displays'));
      writeDisplayInventoryFixture(args[args.indexOf('--json-output') + 1]!);
      return ok;
    },
  });
  let builds = 0;
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleRunnerProvider: () => ({
      hasLiveSession: () => true,
      runCommand: async () => ({}),
    }),
    appleToolProvider: () => ({
      ...tool.provider,
      runCommand: async (command, args) => {
        const probeAnswer = toolchainProbeAnswer(command, args);
        if (probeAnswer) return probeAnswer;
        assert.equal(command, 'xcrun');
        assert.ok(args.includes('clang'));
        builds++;
        fs.writeFileSync(args.at(-1)!, 'fold-helper-binary');
        return ok;
      },
    }),
  });
  try {
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    tool.calls.splice(0);
    const result = await daemon.client().command.fold({
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      keyframes: trajectory,
    });
    assert.equal(result.pose, 'half-open');
    assert.equal(result.hingeAngleDegrees, 100);
    const replayed = await daemon.client().command.fold({
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      keyframes: trajectory,
    });
    assert.equal(replayed.hingeAngleDegrees, 100);
    // The second fold call reuses the cached fold helper binary instead of rebuilding (#2796).
    assert.equal(builds, 1);
    assert.equal(tool.calls.filter((call) => call.includes('spawn')).length, 2);
    assert.equal(tool.calls.filter((call) => call.includes('hinge-angle')).length, 4);
  } finally {
    await daemon.close();
  }
});

// The fold request envelope (`FOLD_REQUEST_TIMEOUT_MS`, packages/command-registry/src/
// timeout-policy.ts) must cover the route's worst-case wall time plus the daemon-result margin
// (REQUEST_TIMEOUT_BUDGET_MARGIN_MS, same file), or a still-progressing fold trips the client
// envelope and resets the daemon before the route's own typed result arrives. This test proves
// that bound against the real route rather than a hand-summed comment: it never imports a
// platform-apple step figure, so it stays true however the route's steps change.
type FoldLedgerCall = Readonly<{
  tool: 'runCommand' | 'simctl' | 'devicectl';
  args: readonly string[];
  timeoutMs: number;
  graceMs?: number;
}>;

/** Two readings this far apart never settle (`IOS_FOLD_POSE_STABLE_DEGREES` is 0.5°), though each
 * one alone matches the 100° target within it — the hinge keeps oscillating without resting. */
function alternatingHingeAngle(readIndex: number): number {
  return readIndex % 2 === 0 ? 99.6 : 100.4;
}

function createFoldLedgerAppleToolProvider(params: {
  hingeAngleAt: (readIndex: number) => number;
  onCall: (call: FoldLedgerCall, signal?: AbortSignal) => void | Promise<void>;
  isTracking: () => boolean;
}): { provider: AppleToolProvider; ledger: FoldLedgerCall[]; hingeReadCount: () => number } {
  const ledger: FoldLedgerCall[] = [];
  let hingeReads = 0;
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  // Every real call on the fold route (packages/platform-apple/src/foldable/simulator-hid.ts,
  // core/tool-provider.ts, core/simctl.ts) carries a bounded timeoutMs. A call reaching this fake
  // with none is not a worst case the envelope assertion below can see, so it must fail the test
  // rather than cost 0 virtual ms.
  const record = async (
    tool: FoldLedgerCall['tool'],
    args: readonly string[],
    options?: { timeoutMs?: number; kill?: { graceMs: number }; signal?: AbortSignal },
  ): Promise<void> => {
    assert.ok(
      Number.isFinite(options?.timeoutMs) && options!.timeoutMs! > 0,
      `fold ledger call has no bounded timeoutMs: ${tool} ${args.join(' ')}`,
    );
    const call: FoldLedgerCall = {
      tool,
      args,
      timeoutMs: options!.timeoutMs!,
      ...(options?.kill ? { graceMs: options.kill.graceMs } : {}),
    };
    ledger.push(call);
    await params.onCall(call, options?.signal);
  };
  // Built on the shared recording provider so any call this route does not script (macosHelper,
  // macosHost, plist, or an unexpected runCommand) throws instead of being silently answered.
  const recording = createRecordingAppleToolProvider({
    simctl: async (args, options) => {
      if (args[0] === 'list') {
        if (params.isTracking()) await record('simctl', args, options);
        return {
          stdout: JSON.stringify({
            devices: {
              'iOS 18.5': [{ udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id, state: 'Booted' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'launch') return ok;
      await record('simctl', args, options);
      return ok;
    },
    devicectl: async (args, options) => {
      await record('devicectl', args, options);
      if (args.includes('hinge-angle')) {
        const angle = params.hingeAngleAt(hingeReads);
        hingeReads += 1;
        return { ...ok, stdout: `Angle: ${angle}°`, exitCode: 1 };
      }
      assert.ok(args.includes('displays'), `unexpected devicectl call: ${args.join(' ')}`);
      writeDisplayInventoryFixture(args[args.indexOf('--json-output') + 1]!);
      return ok;
    },
  });
  const provider: AppleToolProvider = {
    ...recording.provider,
    runCommand: async (cmd, args, options) => {
      await record('runCommand', [cmd, ...args], options);
      const probeAnswer = toolchainProbeAnswer(cmd, args);
      if (probeAnswer) return probeAnswer;
      assert.equal(cmd, 'xcrun', `unexpected runCommand call: ${cmd} ${args.join(' ')}`);
      assert.ok(args.includes('clang'), `unexpected xcrun call: ${args.join(' ')}`);
      fs.writeFileSync(args.at(-1)!, 'fold-helper-binary');
      return ok;
    },
  };
  return { provider, ledger, hingeReadCount: () => hingeReads };
}

/**
 * Runs `fn` under its own throwaway `HOME`, so the fold-helper build cache under it
 * (`~/.agent-device/fold-helper`) starts empty: the calibration and measured ledger runs each
 * need a cold cache, not the outer per-test `HOME` the file's `beforeEach` already scoped, because
 * a warm cache would skip the build phase and shrink the measured ledger.
 */
async function withColdFoldHelperCache<T>(fn: () => Promise<T>): Promise<T> {
  const outerHome = process.env.HOME;
  const runHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-fold-run-home-'));
  process.env.HOME = runHome;
  try {
    return await fn();
  } finally {
    if (outerHome === undefined) delete process.env.HOME;
    else process.env.HOME = outerHome;
    fs.rmSync(runHome, { recursive: true, force: true });
  }
}

/**
 * Runs one cold fold through the public client and daemon against a fake Apple tool provider that
 * records `{ tool, args, timeoutMs, graceMs }` per call. When `withVirtualClock` is set, `Date.now`
 * is spied so every deadline the route reads (host-kit `Deadline`, snapshot-source/deadline.ts)
 * sees each call as having spent `timeoutMs - 1` plus any kill grace: the worst case that still
 * succeeds, never an actual timeout.
 */
async function runFoldLedgerScenario(params: {
  hingeAngleAt: (readIndex: number) => number;
  withVirtualClock: boolean;
}): Promise<{
  response: ProviderScenarioRpcResult;
  ledger: FoldLedgerCall[];
  hingeReadCount: number;
  virtualElapsedMs: number;
}> {
  return withColdFoldHelperCache(async () => {
    const trajectory = [
      { atMs: 0, angle: 0 },
      { atMs: MAX_FOLD_DURATION_MS, angle: 100 },
    ];
    let virtualElapsedMs = 0;
    const dateSpy = params.withVirtualClock ? vi.spyOn(Date, 'now') : undefined;
    let trackFoldCalls = false;
    const { provider, ledger, hingeReadCount } = createFoldLedgerAppleToolProvider({
      hingeAngleAt: params.hingeAngleAt,
      isTracking: () => trackFoldCalls,
      onCall: (call) => {
        virtualElapsedMs += Math.max(0, call.timeoutMs - 1) + (call.graceMs ?? 0);
      },
    });
    const daemon = await createProviderScenarioHarness({
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      appleRunnerProvider: () => ({
        hasLiveSession: () => true,
        runCommand: async () => ({}),
      }),
      appleToolProvider: () => provider,
    });
    try {
      await daemon.client().apps.open({
        app: 'com.example.demo',
        platform: 'ios',
        udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      });
      ledger.splice(0);
      virtualElapsedMs = 0;
      trackFoldCalls = true;
      if (dateSpy) {
        const originNowMs = Date.now();
        dateSpy.mockImplementation(() => originNowMs + virtualElapsedMs);
      }
      const response = await daemon.callCommand('fold', [], {
        platform: 'ios',
        udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
        keyframes: JSON.stringify(trajectory),
      });
      return { response, ledger, hingeReadCount: hingeReadCount(), virtualElapsedMs };
    } finally {
      dateSpy?.mockRestore();
      await daemon.close();
    }
  });
}

function assertFoldLedgerPhaseCoverage(ledger: readonly FoldLedgerCall[]): void {
  const isBuild = (call: FoldLedgerCall) =>
    call.tool === 'runCommand' && call.args.includes('clang');
  const isSpawn = (call: FoldLedgerCall) => call.tool === 'simctl' && call.args.includes('spawn');
  const isHingeRead = (call: FoldLedgerCall) =>
    call.tool === 'devicectl' && call.args.includes('hinge-angle');
  const isDisplayInventory = (call: FoldLedgerCall) =>
    call.tool === 'devicectl' && call.args.includes('displays');

  assert.ok(ledger.some(isBuild), 'ledger is missing the helper-build phase');
  assert.ok(ledger.some(isSpawn), 'ledger is missing the HID-dispatch (simctl spawn) phase');
  assert.ok(ledger.some(isHingeRead), 'ledger is missing the hinge-settle-read phase');
  assert.equal(
    ledger.filter(isDisplayInventory).length,
    2,
    'ledger must record both the foldable-check and the lit-panel display inventory reads',
  );
}

test('fold worst-case ledger covers the client envelope with the daemon-result margin', async () => {
  // Matches REQUEST_TIMEOUT_BUDGET_MARGIN_MS, packages/command-registry/src/timeout-policy.ts.
  // Not imported: it is not exported (fallow would flag an export used only by a test).
  const REQUIRED_DAEMON_RESULT_MARGIN_MS = 30_000;

  // Calibration: learns the route's settle-attempt budget (N) instead of assuming it. Needs no
  // virtual clock, because only the read count is asserted here.
  const calibration = await runFoldLedgerScenario({
    hingeAngleAt: alternatingHingeAngle,
    withVirtualClock: false,
  });
  const calibrationError = assertRpcError(
    calibration.response,
    500,
    'COMMAND_FAILED',
    /did not settle/,
  ) as { details?: { reason?: unknown } };
  assert.equal(calibrationError.details?.reason, 'fold-pose-unsettled');
  const settleAttempts = calibration.hingeReadCount;
  assert.ok(
    settleAttempts >= 2,
    `calibration run made ${settleAttempts} hinge reads; expected at least 2`,
  );

  // Measured: the same alternation for every read but the last, which lands exactly on target so
  // the route settles on the very last read it allows — the worst case that still succeeds.
  const measured = await runFoldLedgerScenario({
    hingeAngleAt: (readIndex) =>
      readIndex === settleAttempts - 1 ? 100 : alternatingHingeAngle(readIndex),
    withVirtualClock: true,
  });
  const measuredData = assertRpcOk(measured.response);
  assert.equal(measuredData.hingeAngleDegrees, 100);
  assert.equal(
    measured.hingeReadCount,
    settleAttempts,
    'the measured run must make exactly as many hinge reads as the calibration run',
  );

  assertFoldLedgerPhaseCoverage(measured.ledger);

  const envelopeMs = resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('fold'), {
    positionals: [],
    flags: {},
  });
  assert.ok(envelopeMs !== undefined, 'fold must declare a bounded envelope');
  assert.ok(
    measured.virtualElapsedMs + REQUIRED_DAEMON_RESULT_MARGIN_MS <= envelopeMs!,
    `fold ledger worst case (${measured.virtualElapsedMs}ms) + ${REQUIRED_DAEMON_RESULT_MARGIN_MS}ms margin ` +
      `exceeds the ${envelopeMs}ms envelope.\nLedger:\n${JSON.stringify(measured.ledger, null, 2)}`,
  );
}, 20_000);

function assertCompositeFoldOutcome(params: {
  response: DaemonResponse;
  command: 'batch' | 'replay';
  timeoutMs?: number;
  operationBudgetMs: number;
  scriptPath: string;
  hingeReadCount: () => number;
  settleAttempts: number;
  ledger: readonly FoldLedgerCall[];
}): void {
  const {
    response,
    command,
    timeoutMs,
    operationBudgetMs,
    scriptPath,
    hingeReadCount,
    settleAttempts,
    ledger,
  } = params;
  if (timeoutMs === 300_000) {
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(hingeReadCount(), settleAttempts);
    assertFoldLedgerPhaseCoverage(ledger);
    return;
  }
  assert.equal(response.ok, false, JSON.stringify(response));
  if (response.ok) return;
  assert.equal(response.error.code, command === 'batch' ? 'COMMAND_FAILED' : 'REPLAY_DIVERGENCE');
  assert.equal(response.error.details?.reason, 'daemon_request_timeout');
  assert.equal(response.error.details?.timeoutMs, operationBudgetMs);
  if (command === 'replay') {
    expect(response.error.details).toMatchObject({
      divergence: { step: { source: { path: scriptPath, line: 1 } } },
    });
  }
}

test.each([
  { command: 'batch' },
  { command: 'replay' },
  { command: 'replay', timeoutMs: 1_000 },
  { command: 'replay', timeoutMs: 120_000 },
  { command: 'replay', timeoutMs: 300_000 },
] as const)(
  '$command worst-case fold returns a daemon result (timeout=$timeoutMs)',
  async ({ command, ...options }) => {
    const timeoutMs = 'timeoutMs' in options ? options.timeoutMs : undefined;
    const calibration = await runFoldLedgerScenario({
      hingeAngleAt: alternatingHingeAngle,
      withVirtualClock: false,
    });
    assert.equal(calibration.response.json.error?.data?.details?.reason, 'fold-pose-unsettled');
    const settleAttempts = calibration.hingeReadCount;
    await withColdFoldHelperCache(async () => {
      const trajectory = [
        { atMs: 0, angle: 0 },
        { atMs: MAX_FOLD_DURATION_MS, angle: 100 },
      ];
      let tracking = false;
      let activeTool = false;
      let firstCall!: () => void;
      const started = new Promise<void>((resolve) => {
        firstCall = resolve;
      });
      const { provider, ledger, hingeReadCount } = createFoldLedgerAppleToolProvider({
        hingeAngleAt: (index) => (index >= settleAttempts - 1 ? 100 : alternatingHingeAngle(index)),
        isTracking: () => tracking,
        onCall: async (call, signal) => {
          if (!tracking) return;
          firstCall();
          activeTool = true;
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(done, call.timeoutMs - 1 + (call.graceMs ?? 0));
              function done() {
                signal?.removeEventListener('abort', aborted);
                resolve();
              }
              function aborted() {
                clearTimeout(timer);
                reject(signal!.reason);
              }
              signal?.addEventListener('abort', aborted, { once: true });
              if (signal?.aborted) aborted();
            });
          } finally {
            activeTool = false;
          }
        },
      });
      const daemon = await createProviderScenarioHarness({
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
        appleRunnerProvider: () => ({ hasLiveSession: () => true, runCommand: async () => ({}) }),
        appleToolProvider: () => provider,
      });
      try {
        await daemon.client().apps.open({
          app: 'com.example.demo',
          platform: 'ios',
          udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
        });
        ledger.splice(0);
        const scriptPath = path.join(isolatedHome, 'fold.ad');
        const request: DaemonWireRequest = {
          token: daemon.token,
          session: 'default',
          command,
          positionals: command === 'replay' ? [scriptPath] : [],
          flags: {
            platform: 'ios',
            udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
            ...(command === 'batch'
              ? {
                  batchSteps: [
                    {
                      command: 'fold',
                      positionals: [],
                      flags: { keyframes: JSON.stringify(trajectory) },
                    },
                  ],
                }
              : {
                  replayScriptSource: {
                    entry: scriptPath,
                    files: { [scriptPath]: `fold --keyframes '${JSON.stringify(trajectory)}'\n` },
                  },
                }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
          meta: { requestId: 'composite-fold-deadline' },
        };
        const envelopeMs = resolveCommandRequestTimeoutMs(
          resolveCommandTimeoutPolicy(command),
          request,
        )!;
        const operationBudgetMs = timeoutMs ?? 60_000;
        assert.equal(envelopeMs, operationBudgetMs + 30_000);
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const start = Date.now();
        tracking = true;
        // Exercise the real client envelope and HTTP transport, including timeout classification.
        const pending: Promise<DaemonResponse> = sendRequest(
          { baseUrl: daemon.baseUrl, token: daemon.token, pid: 1 },
          request,
          'http',
          resolveDaemonPaths(daemon.stateDir),
          envelopeMs,
          { host: createTestHostEnvironment() },
        ).catch((error) => ({ ok: false, error: normalizeError(error) }));
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await started;
        for (let turn = 0; turn < 1000 && !settled; turn++) {
          if (activeTool) await vi.advanceTimersToNextTimerAsync();
          await realSleep(1);
        }
        assert.ok(settled, `composite did not settle; ledger: ${JSON.stringify(ledger)}`);
        const response = await pending;
        const elapsedMs = Date.now() - start;
        assert.ok(
          elapsedMs + 30_000 <= envelopeMs,
          `daemon result lost its margin: ${elapsedMs}; ledger: ${JSON.stringify(ledger)}`,
        );
        assertCompositeFoldOutcome({
          response,
          command,
          timeoutMs,
          operationBudgetMs,
          scriptPath,
          hingeReadCount,
          settleAttempts,
          ledger,
        });
        tracking = false;
        vi.useRealTimers();
        assert.equal(await daemon.hasSession(), true);
        assertRpcOk(
          await daemon.callCommand('fold', [], {
            platform: 'ios',
            udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
            keyframes: JSON.stringify(trajectory),
          }),
        );
      } finally {
        tracking = false;
        vi.useRealTimers();
        await daemon.close();
      }
    });
  },
  20_000,
);
