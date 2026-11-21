import { randomUUID } from 'node:crypto';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { readHostBinaryFile } from '@agent-device/host-kit/host-file';
import type { HarmonyHdcRunner } from './hdc.ts';

export async function screenshotHarmony(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
  outPath: string,
): Promise<void> {
  const remotePath = `/data/local/tmp/agent-device-screen-${randomUUID()}.jpeg`;
  try {
    await hdc.runShell(device, ['snapshot_display', '-f', remotePath], {
      timeoutMs: 15_000,
    });
    await hdc.run(device, ['file', 'recv', remotePath, outPath], { timeoutMs: 15_000 });
    const data = await readHostBinaryFile(outPath);
    if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
      throw new AppError('COMMAND_FAILED', 'HarmonyOS screenshot is not a JPEG file');
    }
  } finally {
    await hdc.runShell(device, ['rm', '-f', remotePath], { allowFailure: true }).catch(() => {});
  }
}
