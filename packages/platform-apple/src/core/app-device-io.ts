import { isMacOs, isTvOsDevice, type DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { ensureBootedSimulator, requireSimulatorDevice } from './simulator.ts';
import { readMacOsClipboardText, writeMacOsClipboardText } from '../os/macos/apps.ts';
import { runSimctlForDevice } from './simctl.ts';
import { runAppleRunnerCommand } from './runner-client.ts';
import type { AppleRunnerCommandOptions } from '../runner/index.ts';

export async function readIosClipboardText(device: DeviceInfo): Promise<string> {
  if (isMacOs(device)) {
    return await readMacOsClipboardText();
  }
  requireSimulatorDevice(device, 'clipboard');
  await ensureBootedSimulator(device);
  const result = requireExecSuccess(
    await runSimctlForDevice(device, ['pbpaste', device.id], { allowFailure: true }),
    'Failed to read iOS simulator clipboard',
  );
  return result.stdout.replaceAll('\r\n', '\n').replace(/\n$/, '');
}

/**
 * Writes the device's pasteboard: the macOS host's directly, and a simulator's from the runner's
 * own process. `simctl pbcopy` hands the simulator only a promise of the data, owned by the `simctl`
 * process that exits before anything on the device reads it, so the pasteboard ends up empty. tvOS
 * has no `UIPasteboard` for its runner to write, so a tvOS simulator keeps `simctl pbcopy`.
 */
export async function writeIosClipboardText(
  device: DeviceInfo,
  text: string,
  runnerOptions?: AppleRunnerCommandOptions,
): Promise<void> {
  if (isMacOs(device)) {
    await writeMacOsClipboardText(text);
    return;
  }
  requireSimulatorDevice(device, 'clipboard');
  if (isTvOsDevice(device)) {
    const signal = runnerOptions?.signal;
    await ensureBootedSimulator(device, { signal });
    requireExecSuccess(
      await runSimctlForDevice(device, ['pbcopy', device.id], {
        allowFailure: true,
        stdin: text,
        signal,
      }),
      'Failed to write tvOS simulator clipboard',
    );
    return;
  }
  await runAppleRunnerCommand(device, { command: 'pasteboardWrite', text }, runnerOptions);
}
