import { Deadline, pollUntilSettled } from '@agent-device/host-kit/retry';
import {
  AppError,
  createRequestCanceledError,
  discloseDispatch,
} from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';

export type AndroidToggleState = 'enabled' | 'disabled';

/**
 * A device-wide switch that `svc` flips and a system service then persists in a `settings global`
 * row. `svc` can exit 0 before the row changes, or without changing it, so the write is confirmed
 * by polling the row until it holds the requested state.
 */
export type AndroidGlobalToggle<Key extends string = string> = Readonly<{
  /** The `svc` service name: `svc <service> enable|disable`. */
  service: string;
  /** The `settings global` row the system service persists the switch in. */
  row: string;
  /** How the toggle is named in failure messages. */
  label: string;
  /** The key the toggle's state is reported under, on success and in failure details. */
  stateKey: Key;
  parseRow: (storedValue: string) => AndroidToggleState | undefined;
  notAppliedReason: string;
  unreadableReason: string;
  sampleIntervalMs: number;
  hint: string;
}>;

const GLOBAL_TOGGLE_SETTLE_MS = 2_000;
/** Each read has its own budget, so the sample taken once the settle window has run out can still answer. */
const GLOBAL_TOGGLE_READ_TIMEOUT_MS = 1_000;

/** Failures before `svc` runs disclose `dispatched: no`; every failure after it `unknown`. */
export async function setAndroidGlobalToggle<Key extends string>(
  device: DeviceInfo,
  toggle: AndroidGlobalToggle<Key>,
  enabled: boolean,
  signal: AbortSignal | undefined,
): Promise<Record<Key, AndroidToggleState>> {
  if (signal?.aborted) throw discloseDispatch(createRequestCanceledError(), 'no');
  const requested: AndroidToggleState = enabled ? 'enabled' : 'disabled';
  try {
    const result = await runAndroidShell(
      device,
      ['svc', toggle.service, enabled ? 'enable' : 'disable'],
      { allowFailure: true, signal },
    );
    if (result.exitCode !== 0) {
      throw androidAdbResultError(
        `Failed to turn Android ${toggle.label} ${enabled ? 'on' : 'off'}`,
        result,
        { deviceId: device.id },
      );
    }
    const state = await awaitAndroidGlobalToggle(device, toggle, requested, signal);
    return { [toggle.stateKey]: state } as Record<Key, AndroidToggleState>;
  } catch (error) {
    throw error instanceof AppError ? discloseDispatch(error, 'unknown') : error;
  }
}

async function awaitAndroidGlobalToggle(
  device: DeviceInfo,
  toggle: AndroidGlobalToggle,
  requested: AndroidToggleState,
  signal: AbortSignal | undefined,
): Promise<AndroidToggleState> {
  const deadline = Deadline.fromTimeoutMs(GLOBAL_TOGGLE_SETTLE_MS);
  const { settled, value } = await pollUntilSettled({
    probe: async () => {
      const result = await runAndroidShell(device, ['settings', 'get', 'global', toggle.row], {
        allowFailure: true,
        signal,
        timeoutMs: GLOBAL_TOGGLE_READ_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        throw androidAdbResultError(`Failed to read Android ${toggle.label} state`, result, {
          deviceId: device.id,
        });
      }
      const storedValue = result.stdout.trim();
      return { storedValue, state: toggle.parseRow(storedValue) };
    },
    settled: (read) => read.state === requested,
    deadline,
    intervalMs: toggle.sampleIntervalMs,
    signal,
  });
  if (settled) return requested;
  throw androidGlobalToggleSettleError(device, toggle, requested, value.state, value.storedValue);
}

function androidGlobalToggleSettleError(
  device: DeviceInfo,
  toggle: AndroidGlobalToggle,
  requested: AndroidToggleState,
  state: AndroidToggleState | undefined,
  storedValue: string,
): AppError {
  const message =
    state === undefined
      ? `Android reported an unusable ${toggle.row} value after requesting ${toggle.label} ${requested}: ${storedValue || '(empty)'}`
      : `Android ${toggle.label} reads ${state} after requesting ${requested}.`;
  return new AppError('COMMAND_FAILED', message, {
    deviceId: device.id,
    reason: state === undefined ? toggle.unreadableReason : toggle.notAppliedReason,
    requested,
    ...(state === undefined ? {} : { [toggle.stateKey]: state }),
    storedValue,
    hint: toggle.hint,
  });
}
