import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import { LONG_PRESS_DURATION_MAX_MS } from '@agent-device/contracts/gesture-plan-types';
import type {
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
  AndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, vi } from 'vitest';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/android-snapshot-helper.ts';
import { respondToAndroidSettingsAdbCommand } from './android-world.ts';
import { assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';

// The longpress envelope must outlast the Android cold-helper route's worst case plus the margin
// that lets the daemon's own typed result arrive first; otherwise the client gives up on a request
// the device is still finishing. This test proves that bound against the real route: it imports no
// platform-android step figure, so it stays true however the route's steps change. The only
// imported figure is the hold cap the validator reads.
//
// One step stays outside this ledger: replacing the helper stops a running snapshot helper session
// first, and that hand-off waits on host-side timers in
// packages/platform-android/src/snapshot-helper-session-lifecycle.ts (stop request, graceful exit,
// process exit) rather than on a provider call this fake can charge. Its device-side stop does go
// through the provider and is charged when it runs.
type LongPressLedgerCall = Readonly<{
  tool: 'exec' | 'install' | 'pull';
  args: readonly string[];
  timeoutMs: number;
}>;

const HELPER = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest;
const HELPER_REMOTE_APK = `/data/app/~~ledger/${HELPER.packageName}/base.apk`;
const ok: AndroidAdbExecutorResult = { stdout: '', stderr: '', exitCode: 0 };

function gestureHelperOutput(): string {
  return [
    `INSTRUMENTATION_RESULT: agentDeviceProtocol=${HELPER.statusProtocol}`,
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_RESULT: kind=swipe',
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}

/**
 * The slowest cold-helper branch the route allows: the installed helper reports the bundled
 * versionCode, so identity falls through to the APK checksum (`pm path` + pull); the pulled APK
 * mismatches, so the helper is replaced; the first replace is rejected as
 * INSTALL_FAILED_UPDATE_INCOMPATIBLE, so the route uninstalls and installs again; then the hold runs
 * one-shot because no live helper session exists.
 */
function createLongPressLedgerAdbProvider(params: {
  isTracking: () => boolean;
  onCall: (call: LongPressLedgerCall) => void;
}): { provider: AndroidAdbProvider; ledger: LongPressLedgerCall[] } {
  const ledger: LongPressLedgerCall[] = [];
  let installAttempts = 0;
  // A call without a bounded timeoutMs is not a worst case the envelope assertion can see, so it
  // fails the test rather than costing 0 virtual ms.
  const record = (
    tool: LongPressLedgerCall['tool'],
    args: readonly string[],
    options?: AndroidAdbExecutorOptions,
  ): void => {
    if (!params.isTracking()) return;
    const timeoutMs = options?.timeoutMs;
    assert.ok(
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0,
      `longpress ledger call has no bounded timeoutMs: ${tool} ${args.join(' ')}`,
    );
    const call: LongPressLedgerCall = { tool, args: [...args], timeoutMs };
    ledger.push(call);
    params.onCall(call);
  };
  const provider: AndroidAdbProvider = {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    exec: async (args, options) => {
      record('exec', args, options);
      // A dump without a focus line sends the dialog and foreground observations through every
      // variant they may read, so each one spends its whole budget.
      if (params.isTracking() && isObservationDump(args)) return ok;
      if (args.includes('--show-versioncode') && args.includes(HELPER.packageName)) {
        return {
          ...ok,
          stdout: `package:${HELPER.packageName} versionCode:${HELPER.versionCode}\n`,
        };
      }
      if (args[0] === 'shell' && args[1] === 'pm' && args[2] === 'path') {
        return { ...ok, stdout: `package:${HELPER_REMOTE_APK}\n` };
      }
      if (args[0] === 'uninstall' && args[1] === HELPER.packageName) {
        return { ...ok, stdout: 'Success\n' };
      }
      if (args.includes('instrument') && args.includes('gesture')) {
        return { ...ok, stdout: gestureHelperOutput() };
      }
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') {
        return { ...ok, stdout: 'Starting: Intent' };
      }
      return respondToAndroidSettingsAdbCommand([...args], '', '', {});
    },
    pull: async (remotePath, localPath, options) => {
      record('pull', [remotePath, localPath], options);
      fs.writeFileSync(localPath, 'a previously installed helper build');
      return ok;
    },
    install: async (apkPath, options) => {
      record('install', [apkPath], options);
      installAttempts += 1;
      if (installAttempts === 1) {
        return {
          stdout: '',
          stderr: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]',
          exitCode: 1,
        };
      }
      return { ...ok, stdout: 'Success\n' };
    },
  };
  return { provider, ledger };
}

function isObservationDump(args: readonly string[]): boolean {
  return (
    args[0] === 'shell' && args[1] === 'dumpsys' && (args[2] === 'window' || args[2] === 'activity')
  );
}

function gestureDurationMs(call: LongPressLedgerCall): number | undefined {
  const payloadIndex = call.args.indexOf('payloadBase64');
  if (payloadIndex < 0) return undefined;
  const payload = JSON.parse(
    Buffer.from(call.args[payloadIndex + 1]!, 'base64').toString('utf8'),
  ) as { durationMs?: unknown };
  return typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
}

function assertLongPressLedgerPhaseCoverage(ledger: readonly LongPressLedgerCall[]): void {
  const printed = `\nLedger:\n${JSON.stringify(ledger, null, 2)}`;
  const isVersionRead = (call: LongPressLedgerCall) =>
    call.tool === 'exec' && call.args.includes('--show-versioncode');
  const isApkPathRead = (call: LongPressLedgerCall) =>
    call.tool === 'exec' && call.args.includes('pm') && call.args.includes('path');
  const isGesture = (call: LongPressLedgerCall) =>
    call.tool === 'exec' && call.args.includes('instrument') && call.args.includes('gesture');

  assert.ok(ledger.some(isVersionRead), `ledger is missing the helper version read${printed}`);
  assert.ok(ledger.some(isApkPathRead), `ledger is missing the helper APK path read${printed}`);
  assert.ok(
    ledger.some((call) => call.tool === 'pull'),
    `ledger is missing the helper APK pull${printed}`,
  );
  assert.equal(
    ledger.filter((call) => call.tool === 'install').length,
    2,
    `ledger must record the rejected helper install and its retry${printed}`,
  );
  assert.ok(
    ledger.some((call) => call.args[0] === 'uninstall'),
    `ledger is missing the incompatible-helper uninstall${printed}`,
  );
  assert.ok(
    ledger.some((call) => call.tool === 'exec' && isObservationDump(call.args)),
    `ledger is missing the dialog and foreground observation dumps${printed}`,
  );
  const gestures = ledger.filter(isGesture);
  assert.equal(gestures.length, 1, `ledger must record exactly one gesture dispatch${printed}`);
  assert.equal(
    gestureDurationMs(gestures[0]!),
    LONG_PRESS_DURATION_MAX_MS,
    `the gesture dispatch must carry the maximum hold${printed}`,
  );
}

test('longpress cold-helper worst-case ledger covers the client envelope with the daemon-result margin', async () => {
  // Matches REQUEST_TIMEOUT_BUDGET_MARGIN_MS, packages/command-registry/src/timeout-policy.ts.
  // Not imported: it is not exported (fallow would flag an export used only by a test).
  const REQUIRED_DAEMON_RESULT_MARGIN_MS = 30_000;

  let virtualElapsedMs = 0;
  let tracking = false;
  const { provider, ledger } = createLongPressLedgerAdbProvider({
    isTracking: () => tracking,
    onCall: (call) => {
      virtualElapsedMs += Math.max(0, call.timeoutMs - 1);
    },
  });
  const dateSpy = vi.spyOn(Date, 'now');
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
    androidAdbProvider: () => provider,
  });
  const selection = { platform: 'android', serial: PROVIDER_SCENARIO_ANDROID.id } as const;
  const positionals = ['195', '320', String(LONG_PRESS_DURATION_MAX_MS)];
  try {
    await daemon.client().apps.open({ app: 'com.android.settings', ...selection, testIme: false });
    tracking = true;
    const originNowMs = Date.now();
    dateSpy.mockImplementation(() => originNowMs + virtualElapsedMs);
    assertRpcOk(await daemon.callCommand('longpress', positionals, selection));
  } finally {
    dateSpy.mockRestore();
    await daemon.close();
  }

  assertLongPressLedgerPhaseCoverage(ledger);

  const envelopeMs = resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('longpress'), {
    positionals,
    flags: {},
  });
  assert.ok(envelopeMs !== undefined, 'longpress must declare a bounded envelope');
  assert.ok(
    virtualElapsedMs + REQUIRED_DAEMON_RESULT_MARGIN_MS <= envelopeMs,
    `longpress ledger worst case (${virtualElapsedMs}ms) + ${REQUIRED_DAEMON_RESULT_MARGIN_MS}ms ` +
      `margin exceeds the ${envelopeMs}ms envelope.\nLedger:\n${JSON.stringify(ledger, null, 2)}`,
  );
}, 20_000);
