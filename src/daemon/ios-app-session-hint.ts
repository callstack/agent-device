import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { appleSessionObservation } from '../platform-runtime-apple-resources.ts';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';

/**
 * Enriches the generic "Run open first" SESSION_NOT_FOUND hint with the exact
 * runnable command when the observation port reports an unambiguous environment.
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

  const resolved = await appleSessionObservation.resolveSoleForegroundApp({
    simulatorSetPath: device.simulatorSetPath,
  });
  if (!resolved) return undefined;

  const command = buildOpenCommand(resolved.device, resolved.app.bundleId);
  const hint =
    `One booted device found ("${resolved.device.name}", udid ${resolved.device.id}) with ` +
    `${resolved.app.bundleId} running. Run: ${command}`;
  return hint.length <= MAX_HINT_LENGTH ? hint : undefined;
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
