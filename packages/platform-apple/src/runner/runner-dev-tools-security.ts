import { AppError } from '@agent-device/kernel/errors';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { runAppleToolCommand } from './host.ts';
import { classifyRunnerStartupFailure } from './runner-error-classification.ts';

const DEV_TOOLS_SECURITY_TIMEOUT_MS = 2_000;

const DEV_TOOLS_SECURITY_REFUSAL_MESSAGE = 'Developer mode is disabled for Apple development tools';

/**
 * The host half of "can this Mac run an Apple UI test at all", probed before the runner builds.
 *
 * `DevToolsSecurity -status` reports the macOS developer-tools security setting that governs
 * debugserver on THIS machine. It is not the iPhone's Settings > Privacy & Security > Developer
 * Mode toggle, which lives on the device and has no host-visible value here — the two states are
 * independent even though the wording is nearly the same, so the failure this throws is labelled
 * with the host's own reason and never with a device-side one (#2680).
 */
export async function assertDevToolsSecurityForIosRunner(device: DeviceInfo): Promise<void> {
  if (!isIosFamily(device) || device.kind !== 'device') return;
  const result = await runAppleToolCommand('DevToolsSecurity', ['-status'], {
    allowFailure: true,
    timeoutMs: DEV_TOOLS_SECURITY_TIMEOUT_MS,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/developer mode is currently disabled/i.test(output)) return;
  throw buildDevToolsSecurityRefusal(output.trim());
}

/**
 * The refusal carries the reason and hint that {@link classifyRunnerStartupFailure} derives from
 * the typed `devToolsSecurityStatus` fact, instead of naming either here, so the pair a caller
 * receives cannot drift from the rule table that owns it.
 */
function buildDevToolsSecurityRefusal(status: string): AppError {
  const observed = new AppError('COMMAND_FAILED', DEV_TOOLS_SECURITY_REFUSAL_MESSAGE, {
    devToolsSecurityStatus: status,
  });
  const { reason, hint } = classifyRunnerStartupFailure(observed);
  return new AppError('COMMAND_FAILED', DEV_TOOLS_SECURITY_REFUSAL_MESSAGE, {
    reason,
    hint,
    devToolsSecurityStatus: status,
  });
}
