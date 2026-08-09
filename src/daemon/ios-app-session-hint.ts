import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { detectSoleRunningIosSimulatorApp } from '../platforms/apple/core/app-resolution.ts';
import type { IosAppInfo } from '../platforms/apple/core/app-info.ts';
import {
  listLocalDeviceInventory,
  shouldPropagateDeviceInventoryProbeError,
} from '../core/device-inventory-context.ts';
import { shellQuoteIfNeeded } from '../utils/shell-quote.ts';

export type ResolvedForegroundIosApp = {
  device: DeviceInfo;
  app: IosAppInfo;
};

/**
 * The shared ambiguity-detection probe: exactly one booted iOS simulator with
 * exactly one app running on it, or `undefined`.
 *
 * Any ambiguity — no booted simulator, more than one, no running app, more
 * than one running app, or a probe failure — returns `undefined`. This must
 * never guess: a wrong-but-confident answer is worse than failing closed.
 *
 * Probe failures (including bounded timeout/spawn failures) are best-effort
 * and treated as inconclusive. Cancellation and missing request-context
 * wiring are control-flow/composition failures and must propagate.
 *
 * `buildIosOpenCommandHint` (error-hint enrichment) and the bare
 * `open --foreground` auto-discovery form both compose this single probe
 * instead of re-deriving the ambiguity rules.
 */
export async function resolveSoleForegroundIosApp(
  options: { simulatorSetPath?: string } = {},
): Promise<ResolvedForegroundIosApp | undefined> {
  try {
    const booted = await listLocalDeviceInventory({
      platform: 'ios',
      iosSimulatorSetPath: options.simulatorSetPath,
      kind: 'simulator',
      booted: true,
    });
    if (booted.length !== 1) return undefined;
    const [soleBootedDevice] = booted;
    if (!soleBootedDevice) return undefined;

    const app = await detectSoleRunningIosSimulatorApp(soleBootedDevice);
    if (!app) return undefined;

    return { device: soleBootedDevice, app };
  } catch (error) {
    if (shouldPropagateDeviceInventoryProbeError(error)) throw error;
    return undefined;
  }
}

/**
 * Enriches the generic "Run open first" SESSION_NOT_FOUND hint with the exact
 * runnable command, but only when the environment is unambiguous (see
 * `resolveSoleForegroundIosApp`, which also owns the never-guess and
 * best-effort probe contract). Ambiguity or a genuine probe failure returns
 * `undefined` so the caller keeps the generic hint.
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

  const resolved = await resolveSoleForegroundIosApp({ simulatorSetPath: device.simulatorSetPath });
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
