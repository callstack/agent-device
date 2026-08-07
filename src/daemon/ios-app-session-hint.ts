import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { detectSoleRunningIosSimulatorApp } from '../platforms/apple/core/app-resolution.ts';
import { listBootedIosSimulators } from '../platforms/apple/core/devices.ts';

/**
 * Enriches the generic "Run open first" SESSION_NOT_FOUND hint with the exact
 * runnable command, but only when the environment is unambiguous: exactly one
 * booted iOS simulator with exactly one app running on it.
 *
 * Any ambiguity — no booted simulator, more than one, no running app, more
 * than one running app, or a probe failure — returns `undefined` so the
 * caller keeps the generic hint. This must never guess: a wrong-but-confident
 * command is worse than the default guidance.
 */
export async function buildIosOpenCommandHint(device: DeviceInfo): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;

  const booted = await listBootedIosSimulators({ simulatorSetPath: device.simulatorSetPath });
  if (booted.length !== 1) return undefined;
  const [soleBootedDevice] = booted;
  if (!soleBootedDevice) return undefined;

  const app = await detectSoleRunningIosSimulatorApp(soleBootedDevice);
  if (!app) return undefined;

  return (
    `One booted device found ("${soleBootedDevice.name}", udid ${soleBootedDevice.id}) with ` +
    `${app.bundleId} in the foreground. Run: agent-device open ${app.bundleId} --platform ios`
  );
}
