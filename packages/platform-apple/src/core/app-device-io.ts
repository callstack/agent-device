import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { ensureBootedSimulator, requireSimulatorDevice } from './simulator.ts';
import { readMacOsClipboardText, writeMacOsClipboardText } from '../os/macos/apps.ts';
import { runSimctlForDevice } from './simctl.ts';

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

export async function writeIosClipboardText(device: DeviceInfo, text: string): Promise<void> {
  if (isMacOs(device)) {
    await writeMacOsClipboardText(text);
    return;
  }
  requireSimulatorDevice(device, 'clipboard');
  await ensureBootedSimulator(device);
  requireExecSuccess(
    await runSimctlForDevice(device, ['pbcopy', device.id], {
      allowFailure: true,
      stdin: text,
    }),
    'Failed to write iOS simulator clipboard',
  );
}
