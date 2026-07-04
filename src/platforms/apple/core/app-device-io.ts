import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '../../../kernel/device.ts';
import { requireExecSuccess } from '../../../utils/exec.ts';
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
  return result.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '');
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
): Promise<void> {
  requireSimulatorDevice(device, 'push');
  await ensureBootedSimulator(device);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-push-'));
  const payloadPath = path.join(tempDir, 'payload.apns');
  try {
    await fs.writeFile(payloadPath, `${JSON.stringify(payload)}\n`, 'utf8');
    await runSimctl(device, ['push', device.id, bundleId, payloadPath]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
