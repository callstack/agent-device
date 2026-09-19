import { AppError } from '@agent-device/kernel/errors';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { runAppleToolCommand } from './host.ts';

const DEV_TOOLS_SECURITY_TIMEOUT_MS = 2_000;

/**
 * The host half of "can this Mac run an Apple UI test at all", probed before the runner builds.
 */
export async function assertDevToolsSecurityForIosRunner(device: DeviceInfo): Promise<void> {
  if (!isIosFamily(device) || device.kind !== 'device') return;
  const result = await runAppleToolCommand('DevToolsSecurity', ['-status'], {
    allowFailure: true,
    timeoutMs: DEV_TOOLS_SECURITY_TIMEOUT_MS,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/developer mode is currently disabled/i.test(output)) return;
  throw new AppError('COMMAND_FAILED', 'Developer mode is disabled for Apple development tools', {
    hint: 'Run `sudo DevToolsSecurity -enable`, then retry the iOS runner. UI test runners start suspended until Xcode/testmanagerd can attach.',
    devToolsSecurityStatus: output.trim(),
  });
}
