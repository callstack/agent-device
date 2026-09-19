import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  IosDeveloperDiskImageState,
  IosDeveloperModeState,
  IosDeviceReadiness,
} from '../runner/runner-contract.ts';
import { readIosDeviceDetails } from './physical-device-coredevice.ts';

const IOS_DEVICE_READINESS_TIMEOUT_MS = 10_000;

/**
 * What a device whose report could not be read needs: a way to read it, and no diagnosis. No fact
 * means no claim, so this shape never names a cause (#2683).
 */
const IOS_DEVICE_READINESS_UNREADABLE_HINT =
  'Read the device state directly with `xcrun devicectl device info details --device <id> --json-output -`, keeping the device unlocked and connected by cable, then retry.';

/**
 * The device's own answer to "can this iPhone run development tooling right now" (#2683).
 *
 * This reads and never interprets: `developerModeStatus` is the owner's toggle in Settings >
 * Privacy & Security > Developer Mode, and `ddiServicesAvailable` is whether the device exposes
 * developer disk image services. Both are copied into their own field so the reader that draws a
 * verdict can tell that one arrived and the other did not, which is what stops an image complaint
 * from being answered as a toggle problem. What the states mean for a runner is decided by
 * `runner/runner-device-readiness.ts`, beside the rules and hints that name them.
 */
export async function readIosDeviceReadiness(
  device: DeviceInfo,
  timeoutBudgetMs = IOS_DEVICE_READINESS_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<IosDeviceReadiness> {
  const details = await readIosDeviceDetails(device, timeoutBudgetMs, signal);
  if (!details) {
    return {
      available: false,
      reason: 'device_readiness_unreadable',
      hint: IOS_DEVICE_READINESS_UNREADABLE_HINT,
    };
  }
  return {
    available: true,
    developerMode: readDeveloperModeState(details.developerModeStatus),
    developerDiskImage: readDeveloperDiskImageState(details.developerDiskImageServicesAvailable),
  };
}

/**
 * Only the two spellings CoreDevice uses are states. A missing key or a spelling we do not know
 * stays `unknown`: the point of asking the device is that we repeat what it said, so an answer we
 * cannot recognise cannot be read as either permission or accusation.
 */
function readDeveloperModeState(status: string | undefined): IosDeveloperModeState {
  const spelled = status?.toLowerCase();
  if (spelled === 'enabled') return 'enabled';
  if (spelled === 'disabled') return 'disabled';
  return 'unknown';
}

function readDeveloperDiskImageState(available: boolean | undefined): IosDeveloperDiskImageState {
  if (available === true) return 'available';
  if (available === false) return 'unavailable';
  return 'unknown';
}
