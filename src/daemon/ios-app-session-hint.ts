import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveSoleForegroundIosApp } from '../platform-runtime-open-target.ts';
import { shellQuoteIfNeeded } from '@agent-device/host-kit/command';

export { resolveSoleForegroundIosApp } from '../platform-runtime-open-target.ts';

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
 * `buildIosOpenCommandHint` is its only command-facing consumer; the actual bare
 * `open --foreground` probe belongs to the admitted Apple lifecycle binding.
 */
/**
 * Enriches the generic "Run open first" SESSION_NOT_FOUND hint with the exact
 * runnable command, but only when the environment is unambiguous (see
 * `resolveSoleForegroundIosApp`, which owns the never-guess and best-effort
 * probe contract). Ambiguity or a genuine probe failure returns
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
