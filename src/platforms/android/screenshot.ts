import { promises as fs } from 'node:fs';
import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { runAndroidAdb, sleep } from './adb.ts';

// PNG file signature: 0x89 P N G \r \n 0x1A \n
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ANDROID_SCREENSHOT_SETTLE_DELAY_MS = 1_000;

export type AndroidScreenshotOptions = {
  stabilize?: boolean;
};

export async function screenshotAndroid(
  device: DeviceInfo,
  outPath: string,
  options: AndroidScreenshotOptions = {},
): Promise<void> {
  if (options.stabilize === false) {
    await captureAndroidScreenshot(device, outPath);
    return;
  }

  await enableAndroidDemoMode(device);
  try {
    // Allow transient UI affordances like scrollbars to fade before capture.
    await sleep(ANDROID_SCREENSHOT_SETTLE_DELAY_MS);
    await captureAndroidScreenshot(device, outPath);
  } finally {
    await disableAndroidDemoMode(device).catch(() => {});
  }
}

/**
 * Enable Android demo mode and set deterministic time in status bar
 * for consistent screenshots.
 */
async function enableAndroidDemoMode(device: DeviceInfo): Promise<void> {
  const shell = (cmd: string) => runAndroidAdb(device, ['shell', cmd], { allowFailure: true });

  await shell('settings put global sysui_demo_allowed 1');

  const broadcast = (extra: string) =>
    shell(`am broadcast -a com.android.systemui.demo -e command ${extra}`);

  await broadcast('clock -e hhmm 0941');
  await broadcast('notifications -e visible false');
}

/** Disable demo mode and restore the live status bar. */
async function disableAndroidDemoMode(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(
    device,
    ['shell', 'am broadcast -a com.android.systemui.demo -e command exit'],
    {
      allowFailure: true,
    },
  );
}

async function captureAndroidScreenshot(device: DeviceInfo, outPath: string): Promise<void> {
  const result = await runAndroidAdb(device, ['exec-out', 'screencap', '-p'], {
    binaryStdout: true,
  });
  if (!result.stdoutBuffer) {
    throw new AppError('COMMAND_FAILED', 'Failed to capture screenshot');
  }

  // On multi-display devices (e.g. Galaxy Z Fold), adb screencap may write a
  // warning to stdout before the PNG data. Strip any leading garbage by
  // locating the PNG signature and discarding everything before it.
  const pngOffset = result.stdoutBuffer.indexOf(PNG_SIGNATURE);
  if (pngOffset < 0) {
    throw new AppError('COMMAND_FAILED', 'Screenshot data does not contain a valid PNG header');
  }

  const pngEndOffset = findPngEndOffset(result.stdoutBuffer, pngOffset);
  if (!pngEndOffset) {
    throw new AppError('COMMAND_FAILED', 'Screenshot data does not contain a complete PNG payload');
  }

  await fs.writeFile(outPath, result.stdoutBuffer.subarray(pngOffset, pngEndOffset));
}

function findPngEndOffset(buffer: Buffer, pngStartOffset: number): number | null {
  let offset = pngStartOffset + PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkTypeOffset = offset + 4;
    const chunkType = buffer.toString('ascii', chunkTypeOffset, chunkTypeOffset + 4);
    const chunkEnd = offset + 12 + chunkLength; // len(4) + type(4) + data + crc(4)
    if (chunkEnd > buffer.length) return null;
    if (chunkType === 'IEND') return chunkEnd;
    offset = chunkEnd;
  }
  return null;
}
