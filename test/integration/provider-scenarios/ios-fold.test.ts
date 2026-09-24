import { formatPortableActionLine, parseReplayScriptDetailed } from '@agent-device/ad-script';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import { MAX_FOLD_DURATION_MS } from '@agent-device/contracts/device';
import type { AppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import type { ExecResult } from '@agent-device/host-kit/command';
import { recordActionEntry } from '../../../src/daemon/session-action-recorder.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { makeIosAppSession } from '../../../src/__tests__/test-utils/session-factories.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
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
 * Answers the host-toolchain probe (`xcodebuild -version`, `sw_vers`, `uname -m`) the fold-helper
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
  if (cmd === 'uname') return { stdout: 'arm64', stderr: '', exitCode: 0 };
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
  daemon.setSession(
    'default',
    makeIosAppSession('default', { device: PROVIDER_SCENARIO_IOS_SIMULATOR }),
  );
  try {
    const result = await daemon.client().command.fold({
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      keyframes: trajectory,
    });
    assert.equal(result.pose, 'half-open');
    assert.equal(result.hingeAngleDegrees, 100);
    const recorded = recordActionEntry(daemon.session()!, {
      command: 'fold',
      positionals: [],
      flags: { keyframes: JSON.stringify(trajectory) },
      result,
    });
    assert.ok(recorded);
    const line = formatPortableActionLine(recorded);
    assert.match(line, /--keyframes/);
    const [parsed] = parseReplayScriptDetailed(line).actions;
    assert.ok(parsed);
    const replayed = assertRpcOk(
      await daemon.callCommand(parsed.command, parsed.positionals ?? [], parsed.flags),
    );
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
  onCall: (call: FoldLedgerCall) => void;
}): { provider: AppleToolProvider; ledger: FoldLedgerCall[]; hingeReadCount: () => number } {
  const ledger: FoldLedgerCall[] = [];
  let hingeReads = 0;
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  // Every real call on the fold route (packages/platform-apple/src/foldable/simulator-hid.ts,
  // core/tool-provider.ts, core/simctl.ts) carries a bounded timeoutMs. A call reaching this fake
  // with none is not a worst case the envelope assertion below can see, so it must fail the test
  // rather than cost 0 virtual ms.
  const record = (
    tool: FoldLedgerCall['tool'],
    args: readonly string[],
    options?: { timeoutMs?: number; kill?: { graceMs: number } },
  ): void => {
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
    params.onCall(call);
  };
  // Built on the shared recording provider so any call this route does not script (macosHelper,
  // macosHost, plist, or an unexpected runCommand) throws instead of being silently answered.
  const recording = createRecordingAppleToolProvider({
    simctl: async (args, options) => {
      record('simctl', args, options);
      return ok;
    },
    devicectl: async (args, options) => {
      record('devicectl', args, options);
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
      record('runCommand', [cmd, ...args], options);
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
    const originNowMs = Date.now();
    const dateSpy = params.withVirtualClock
      ? vi.spyOn(Date, 'now').mockImplementation(() => originNowMs + virtualElapsedMs)
      : undefined;
    const { provider, ledger, hingeReadCount } = createFoldLedgerAppleToolProvider({
      hingeAngleAt: params.hingeAngleAt,
      onCall: (call) => {
        virtualElapsedMs += Math.max(0, call.timeoutMs - 1) + (call.graceMs ?? 0);
      },
    });
    const daemon = await createProviderScenarioHarness({
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      appleToolProvider: () => provider,
    });
    daemon.setSession(
      'default',
      makeIosAppSession('default', { device: PROVIDER_SCENARIO_IOS_SIMULATOR }),
    );
    try {
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
});
