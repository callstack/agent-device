import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import {
  makeHostTemporaryDirectory,
  removeHostPath,
  writeHostTextFile,
} from '@agent-device/host-kit/host-file';
import { ensureBootedSimulator, requireSimulatorDevice } from './simulator.ts';
import { readMacOsClipboardText, writeMacOsClipboardText } from '../os/macos/apps.ts';
import { runSimctl } from './apps-simctl.ts';

export async function readIosClipboardText(device: DeviceInfo): Promise<string> {
  if (isMacOs(device)) {
    return await readMacOsClipboardText();
  }
  requireSimulatorDevice(device, 'clipboard');
  await ensureBootedSimulator(device);
  const result = requireExecSuccess(
    await runSimctl(device, ['pbpaste', device.id], { allowFailure: true }),
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
    await runSimctl(device, ['pbcopy', device.id], {
      allowFailure: true,
      stdin: text,
    }),
    'Failed to write iOS simulator clipboard',
  );
}

export async function pushIosNotification(
  device: DeviceInfo,
  bundleId: string,
  payload: Record<string, unknown>,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<void> {
  requireSimulatorDevice(device, 'push');
  options.signal?.throwIfAborted();
  await ensureBootedSimulator(device, { signal: options.signal });
  const tempDir = await makeHostTemporaryDirectory('agent-device-ios-push-');
  const payloadPath = path.join(tempDir, 'payload.apns');
  try {
    await writeHostTextFile(payloadPath, `${JSON.stringify(payload)}\n`);
    await runSimctl(device, ['push', device.id, bundleId, payloadPath], {
      signal: options.signal,
    });
  } finally {
    await removeHostPath(tempDir);
  }
}
