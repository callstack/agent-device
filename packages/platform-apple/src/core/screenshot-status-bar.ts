import type { DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';

import { runSimctlForDevice } from './simctl.ts';
import { extractAppleToolErrorMeta } from './tool-diagnostics.ts';

type RestorableStatusBarOverrides = Partial<
  Record<
    'dataNetwork' | 'wifiMode' | 'wifiBars' | 'cellularMode' | 'cellularBars' | 'operatorName',
    string
  >
>;

const DETERMINISTIC_SCREENSHOT_STATUS_BAR_ARGS = [
  '--time',
  '9:41',
  '--dataNetwork',
  'wifi',
  '--wifiMode',
  'active',
  '--wifiBars',
  '3',
  '--batteryState',
  'charged',
  '--batteryLevel',
  '100',
];

const DATA_NETWORK_TYPE_BY_CODE: Record<number, string> = {
  0: 'hide',
  1: 'wifi',
  6: '3g',
  7: '4g',
  8: 'lte',
  9: 'lte-a',
  10: 'lte+',
  11: '5g',
  12: '5g+',
  13: '5g-uwb',
  14: '5g-uc',
};

const WIFI_MODE_BY_CODE: Partial<Record<number, string>> = {
  1: 'searching',
  2: 'failed',
  3: 'active',
};

const CELLULAR_MODE_BY_CODE: Record<number, string> = {
  0: 'notSupported',
  1: 'searching',
  2: 'failed',
  3: 'active',
};

const devicesKnownWithoutStatusBarOverrides = new Set<string>();

/** One entry per simulator whose status bar a capture is holding right now. */
const simulatorStatusBarTransactions = new Map<string, Promise<unknown>>();

/** Bounds one `simctl status_bar` step so a wedged tool cannot hold a simulator's captures. */
const STATUS_BAR_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Budget for the restore specifically. Leaving the normalization on the simulator is the failure
 * this owner exists to prevent, so the restore is given the longer deadline; it is still bounded,
 * because an untimed wedged tool would hold the simulator's captures forever.
 */
const STATUS_BAR_RESTORE_TIMEOUT_MS = 30_000;

/** What the simulator's status bar held before a capture normalized it. */
type StatusBarOverrideSnapshot = {
  /** False when the tool refused to answer, so nothing here is safe to restore to. */
  canRestore: boolean;
  overrides: RestorableStatusBarOverrides | null;
};

/**
 * Runs `capture` with the simulator status bar normalized, then restores the overrides the
 * simulator held before this call. One simulator handles one of these at a time: the normalization
 * is temporary state, so a capture that overlapped another would snapshot it and later hand it back
 * as though the caller had set it. A status bar problem never decides whether `capture` runs or
 * what it returns.
 *
 * `signal` cancels the wait for the simulator only. It is not handed to the status bar commands: a
 * request that gives up must not leave the normalization behind, so the restore runs to its budget
 * instead — {@link STATUS_BAR_COMMAND_TIMEOUT_MS} per setup command and the longer
 * {@link STATUS_BAR_RESTORE_TIMEOUT_MS} per restore command, so even a wedged `simctl` cannot hold
 * the simulator forever.
 */
export async function withNormalizedSimulatorStatusBar<T>(
  device: DeviceInfo,
  capture: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withKeyedLock(
    simulatorStatusBarTransactions,
    statusBarSimulatorKey(device),
    async () => {
      const snapshot = await snapshotSimulatorStatusBarOverrides(device);
      await normalizeSimulatorStatusBar(device, snapshot);
      try {
        return await capture();
      } finally {
        await restoreSimulatorStatusBarOverrides(
          device,
          snapshot.canRestore ? snapshot.overrides : null,
        ).catch((error) => emitSimulatorStatusBarDiagnostic(device, 'restore_failed', error));
      }
    },
    signal,
  );
}

/**
 * Reserves one simulator's status bar while `capture` runs, without changing the bar. A capture that
 * does not normalize still has to wait: while another capture normalizes the bar, this one would
 * otherwise take its screenshot of the temporary 9:41 overrides.
 */
export async function withSimulatorStatusBarHeld<T>(
  device: DeviceInfo,
  capture: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withKeyedLock(
    simulatorStatusBarTransactions,
    statusBarSimulatorKey(device),
    capture,
    signal,
  );
}

async function snapshotSimulatorStatusBarOverrides(
  device: DeviceInfo,
): Promise<StatusBarOverrideSnapshot> {
  if (hasKnownClearedStatusBarOverrides(device)) {
    return { canRestore: true, overrides: null };
  }
  try {
    return { canRestore: true, overrides: await readSimulatorStatusBarOverrides(device) };
  } catch (error) {
    emitSimulatorStatusBarDiagnostic(device, 'snapshot_failed', error);
    return { canRestore: false, overrides: null };
  }
}

async function normalizeSimulatorStatusBar(
  device: DeviceInfo,
  snapshot: StatusBarOverrideSnapshot,
): Promise<void> {
  try {
    if (!snapshot.canRestore || snapshot.overrides) {
      await clearSimulatorStatusBarOverride(device);
    }
    await applySimulatorStatusBarOverrideArgs(device, DETERMINISTIC_SCREENSHOT_STATUS_BAR_ARGS);
  } catch (error) {
    emitSimulatorStatusBarDiagnostic(device, 'prepare_failed', error);
  }
}

async function restoreSimulatorStatusBarOverrides(
  device: DeviceInfo,
  overrides: RestorableStatusBarOverrides | null,
): Promise<void> {
  await clearSimulatorStatusBarOverride(device, STATUS_BAR_RESTORE_TIMEOUT_MS);
  if (!overrides) {
    rememberClearedStatusBarOverrides(device);
    return;
  }
  await applySimulatorStatusBarOverrideArgs(
    device,
    buildRestorableStatusBarOverrideArgs(overrides),
    STATUS_BAR_RESTORE_TIMEOUT_MS,
  );
  invalidateSimulatorStatusBarOverrideCache(device);
}

export function invalidateSimulatorStatusBarOverrideCache(device: DeviceInfo): void {
  devicesKnownWithoutStatusBarOverrides.delete(statusBarSimulatorKey(device));
}

export function rememberClearedStatusBarOverrides(device: DeviceInfo): void {
  devicesKnownWithoutStatusBarOverrides.add(statusBarSimulatorKey(device));
}

function hasKnownClearedStatusBarOverrides(device: DeviceInfo): boolean {
  return devicesKnownWithoutStatusBarOverrides.has(statusBarSimulatorKey(device));
}

/**
 * Key for both the known-cleared cache and the transaction lock. It names a simulator by platform,
 * kind and id, and leaves out the device set, so two records of one simulator share a key and one
 * transaction instead of normalizing the same status bar at once.
 */
function statusBarSimulatorKey(device: DeviceInfo): string {
  return `${device.platform}:${device.kind}:${device.id}`;
}

async function readSimulatorStatusBarOverrides(
  device: DeviceInfo,
): Promise<RestorableStatusBarOverrides | null> {
  const result = requireExecSuccess(
    await runSimctlForDevice(device, ['status_bar', device.id, 'list'], {
      allowFailure: true,
      timeoutMs: STATUS_BAR_COMMAND_TIMEOUT_MS,
    }),
    'Failed to read simulator status bar overrides',
  );
  return parseSimulatorStatusBarOverrides(result.stdout);
}

async function clearSimulatorStatusBarOverride(
  device: DeviceInfo,
  timeoutMs = STATUS_BAR_COMMAND_TIMEOUT_MS,
): Promise<void> {
  await runSimctlForDevice(device, ['status_bar', device.id, 'clear'], { timeoutMs });
}

async function applySimulatorStatusBarOverrideArgs(
  device: DeviceInfo,
  args: string[],
  timeoutMs = STATUS_BAR_COMMAND_TIMEOUT_MS,
): Promise<void> {
  if (args.length === 0) return;
  await runSimctlForDevice(device, ['status_bar', device.id, 'override', ...args], { timeoutMs });
}

function parseSimulatorStatusBarOverrides(output: string): RestorableStatusBarOverrides | null {
  const overrides: RestorableStatusBarOverrides = {};
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && line !== 'Current Status Bar Overrides:' && !/^=+$/.test(line),
    );

  for (const line of lines) {
    const dataNetworkMatch = /^DataNetworkType:\s+(\d+)$/.exec(line);
    if (dataNetworkMatch) {
      const code = Number(dataNetworkMatch[1]);
      const value = DATA_NETWORK_TYPE_BY_CODE[code];
      if (!value) {
        throw new AppError('COMMAND_FAILED', `Unsupported simulator data network type: ${code}`);
      }
      overrides.dataNetwork = value;
      continue;
    }

    const wifiMatch = /^WiFi Mode:\s+(\d+),\s+WiFi Bars:\s+(\d+)$/.exec(line);
    if (wifiMatch) {
      const mode = WIFI_MODE_BY_CODE[Number(wifiMatch[1])];
      if (mode) {
        overrides.wifiMode = mode;
      }
      overrides.wifiBars = wifiMatch[2];
      continue;
    }

    const cellMatch = /^Cell Mode:\s+(\d+),\s+Cell Bars:\s+(\d+)$/.exec(line);
    if (cellMatch) {
      const code = Number(cellMatch[1]);
      const mode = CELLULAR_MODE_BY_CODE[code];
      if (!mode) {
        throw new AppError('COMMAND_FAILED', `Unsupported simulator cellular mode: ${code}`);
      }
      overrides.cellularMode = mode;
      overrides.cellularBars = cellMatch[2];
      continue;
    }

    const operatorNameMatch = /^Operator Name:\s*(.*)$/.exec(line);
    if (operatorNameMatch) {
      overrides.operatorName = operatorNameMatch[1] ?? '';
      continue;
    }
  }

  return Object.keys(overrides).length === 0 ? null : overrides;
}

function buildRestorableStatusBarOverrideArgs(overrides: RestorableStatusBarOverrides): string[] {
  const args: string[] = [];
  if (overrides.dataNetwork) {
    args.push('--dataNetwork', overrides.dataNetwork);
  }
  if (overrides.wifiMode) {
    args.push('--wifiMode', overrides.wifiMode);
  }
  if (
    overrides.wifiBars !== undefined &&
    (overrides.dataNetwork === 'wifi' || overrides.wifiMode)
  ) {
    args.push('--wifiBars', overrides.wifiBars);
  }
  if (overrides.cellularMode) {
    args.push('--cellularMode', overrides.cellularMode);
  }
  if (
    overrides.cellularBars !== undefined &&
    (overrides.cellularMode ||
      isCellularDataNetworkType(overrides.dataNetwork) ||
      overrides.operatorName !== undefined)
  ) {
    args.push('--cellularBars', overrides.cellularBars);
  }
  if (overrides.operatorName !== undefined) {
    args.push('--operatorName', overrides.operatorName);
  }
  return args;
}

function isCellularDataNetworkType(value: string | undefined): boolean {
  return Boolean(value && value !== 'hide' && value !== 'wifi');
}

/**
 * Records one best-effort status bar step that failed, under `ios_screenshot_status_bar_<phase>`.
 * A status bar problem never decides a screenshot's outcome, so every caller of this swallows the
 * error and the transaction still runs the capture.
 */
function emitSimulatorStatusBarDiagnostic(
  device: DeviceInfo,
  phase: 'snapshot_failed' | 'prepare_failed' | 'restore_failed',
  error: unknown,
): void {
  emitDiagnostic({
    level: 'warn',
    phase: `ios_screenshot_status_bar_${phase}`,
    data: {
      platform: device.platform,
      deviceKind: device.kind,
      deviceId: device.id,
      ...extractAppleToolErrorMeta(error),
    },
  });
}
