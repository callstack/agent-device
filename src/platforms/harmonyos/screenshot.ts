import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runHarmonyHdc } from './hdc.ts';

export async function screenshotHarmony(device: DeviceInfo, outPath: string): Promise<void> {
  const remotePath = `/data/local/tmp/agent-device-screen-${randomUUID()}.jpeg`;
  try {
    await runHarmonyHdc(device, ['shell', 'snapshot_display', '-f', remotePath], {
      timeoutMs: 15_000,
    });
    await runHarmonyHdc(device, ['file', 'recv', remotePath, outPath], { timeoutMs: 15_000 });
    const data = await fs.readFile(outPath);
    if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
      throw new AppError('COMMAND_FAILED', 'HarmonyOS screenshot is not a JPEG file');
    }
  } finally {
    await runHarmonyHdc(device, ['shell', 'rm', '-f', remotePath], { allowFailure: true }).catch(
      () => {},
    );
  }
}
