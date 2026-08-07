import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { detectSoleRunningIosSimulatorApp } from '../platforms/apple/core/app-resolution.ts';
import { listBootedIosSimulators } from '../platforms/apple/core/devices.ts';
import { shellQuoteIfNeeded } from '../utils/shell-quote.ts';

/**
 * Enriches the generic "Run open first" SESSION_NOT_FOUND hint with the exact
 * runnable command, but only when the environment is unambiguous: exactly one
 * booted iOS simulator with exactly one app running on it.
 *
 * Any ambiguity — no booted simulator, more than one, no running app, more
 * than one running app, or a probe failure — returns `undefined` so the
 * caller keeps the generic hint. This must never guess: a wrong-but-confident
 * command is worse than the default guidance.
 *
 * The whole probe is strictly best-effort: it runs on an error path, so a
 * throw here (a bounded probe still rejects on timeout or a spawn failure —
 * see app-resolution.ts) must fall back to `undefined`, never replace the
 * caller's deterministic error with a probe failure.
 */
// Wire-level details are redacted before send (packages/kernel/src/redaction.ts),
// which silently truncates any string field over 400 chars — a truncated
// mid-command hint is a worse failure mode than the generic default (it looks
// actionable but isn't). A long --ios-simulator-device-set path (the
// bench-clone case) can push the composed hint past that, so this stays
// comfortably under it and falls back rather than risk truncation.
const MAX_HINT_LENGTH = 350;

export async function buildIosOpenCommandHint(device: DeviceInfo): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;

  try {
    const booted = await listBootedIosSimulators({ simulatorSetPath: device.simulatorSetPath });
    if (booted.length !== 1) return undefined;
    const [soleBootedDevice] = booted;
    if (!soleBootedDevice) return undefined;

    const app = await detectSoleRunningIosSimulatorApp(soleBootedDevice);
    if (!app) return undefined;

    const command = buildOpenCommand(soleBootedDevice, app.bundleId);
    const hint =
      `One booted device found ("${soleBootedDevice.name}", udid ${soleBootedDevice.id}) with ` +
      `${app.bundleId} running. Run: ${command}`;
    return hint.length <= MAX_HINT_LENGTH ? hint : undefined;
  } catch {
    return undefined;
  }
}

// Always pins --udid: the sole-booted-device check only proves there is one
// booted simulator within `device`'s own simulator set, not that a fresh CLI
// invocation (no --ios-simulator-device-set) would land on it too — a custom
// device set (the bench-clone case) is otherwise invisible to the default
// set. --ios-simulator-device-set is echoed back whenever the detected
// device carries one, so the printed command is the actual command that was
// live-validated, not a shorter one that happens to work by coincidence.
function buildOpenCommand(device: DeviceInfo, bundleId: string): string {
  const deviceSetFlag = device.simulatorSetPath
    ? ` --ios-simulator-device-set ${shellQuoteIfNeeded(device.simulatorSetPath)}`
    : '';
  return `agent-device open ${bundleId} --platform ios --udid ${device.id}${deviceSetFlag}`;
}
