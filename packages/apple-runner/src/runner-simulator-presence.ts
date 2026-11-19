import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  buildSimctlArgsForDevice,
  emitDiagnostic,
  isRecord,
  runXcrun,
  wasSimulatorRecentlyObservedBooted,
} from './host.ts';

/** Budget for the listing that confirms a session's booted simulator still exists. */
const SIMULATOR_LISTING_TIMEOUT_MS = 5_000;

/**
 * A session's `booted` fact dates from its open, and an external pool can delete the simulator since.
 * xcodebuild then waits out its whole destination timeout and exits with a failure that reads like a
 * broken runner cache (#4687). One listing before the launch names the missing simulator instead.
 * A Booted observation this process made moments ago already proves the simulator exists, so an
 * `open` that just checked readiness pays nothing.
 */
export async function assertBootedSimulatorStillListed(
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<void> {
  if (await wasSimulatorRecentlyObservedBooted(device)) return;
  let listed: boolean | undefined;
  try {
    const listing = await runXcrun(buildSimctlArgsForDevice(device, ['list', 'devices', '-j']), {
      allowFailure: true,
      timeoutMs: SIMULATOR_LISTING_TIMEOUT_MS,
      signal,
    });
    listed = listing.exitCode === 0 ? simctlListingHasDevice(listing.stdout, device.id) : undefined;
  } catch (error) {
    signal?.throwIfAborted();
    // CONSERVATIVE: a listing that failed proves nothing about the simulator, so the launch goes on.
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_startup_simulator_listing_failed',
      data: { deviceId: device.id, error: String(error) },
    });
    return;
  }
  // CONSERVATIVE: only a readable listing that omits the simulator refuses the start.
  if (listed !== false) return;
  throw new AppError('DEVICE_NOT_FOUND', `iOS simulator ${device.id} no longer exists`, {
    deviceId: device.id,
    ...(device.simulatorSetPath ? { simulatorSetPath: device.simulatorSetPath } : {}),
    dispatched: 'no',
    hint: 'The simulator this session targets was deleted. Close this session, then open the app on an existing simulator (run devices to list them).',
  });
}

/** Whether `simctl list devices -j` lists this udid; undefined when the output is not a listing. */
function simctlListingHasDevice(stdout: string, udid: string): boolean | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || !isRecord(payload.devices)) return undefined;
  return Object.values(payload.devices).some(
    (devices) =>
      Array.isArray(devices) && devices.some((entry) => isRecord(entry) && entry.udid === udid),
  );
}
