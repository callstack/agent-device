import type { ScreenshotCaptureFacts } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ShellWord } from '@agent-device/kernel/device-shell';
import { runAndroidExecOut, runAndroidShell, sleep } from './adb.ts';
import { requireAndroidAdbHost } from './adb-host.ts';
import { probeAndroidDisplayRotation } from './input-actions.ts';

// PNG file signature: 0x89 P N G \r \n 0x1A \n
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ANDROID_SCREENSHOT_SETTLE_DELAY_MS = 1_000;
const ANDROID_SCREENSHOT_ROTATION_PROBE_TIMEOUT_MS = 2_000;
// The rotation probe is optional metadata: one still running once the image is written gets this
// long, then is aborted, so a slow `dumpsys` adds at most this much to a screenshot and no adb
// work outlives it.
const ANDROID_SCREENSHOT_ROTATION_GRACE_MS = 250;

export type AndroidScreenshotOptions = {
  stabilize?: boolean;
};

export async function screenshotAndroid(
  device: DeviceInfo,
  outPath: string,
  options: AndroidScreenshotOptions = {},
): Promise<ScreenshotCaptureFacts> {
  if (options.stabilize === false) {
    return await captureAndroidScreenshotWithRotation(device, outPath);
  }

  await enableAndroidDemoMode(device);
  try {
    // Allow transient UI affordances like scrollbars to fade before capture.
    await sleep(ANDROID_SCREENSHOT_SETTLE_DELAY_MS);
    return await captureAndroidScreenshotWithRotation(device, outPath);
  } finally {
    await disableAndroidDemoMode(device).catch(() => {});
  }
}

/**
 * Enable Android demo mode and set deterministic time in status bar
 * for consistent screenshots.
 */
async function enableAndroidDemoMode(device: DeviceInfo): Promise<void> {
  const shell = (words: ShellWord[]) => runAndroidShell(device, words, { allowFailure: true });

  await shell(['settings', 'put', 'global', 'sysui_demo_allowed', '1']);

  const broadcast = (extra: ShellWord[]) =>
    shell(['am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', ...extra]);

  await broadcast(['clock', '-e', 'hhmm', '0941']);
  await broadcast(['notifications', '-e', 'visible', 'false']);
}

/** Disable demo mode and restore the live status bar. */
async function disableAndroidDemoMode(device: DeviceInfo): Promise<void> {
  await runAndroidShell(
    device,
    ['am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit'],
    {
      allowFailure: true,
    },
  );
}

async function captureAndroidScreenshotWithRotation(
  device: DeviceInfo,
  outPath: string,
): Promise<ScreenshotCaptureFacts> {
  const probeController = new AbortController();
  const probe = probeAndroidDisplayRotation(device, {
    timeoutMs: ANDROID_SCREENSHOT_ROTATION_PROBE_TIMEOUT_MS,
    signal: probeController.signal,
  });
  try {
    await captureAndroidScreenshot(device, outPath);
    const displayRotation = await settledWithin(probe, ANDROID_SCREENSHOT_ROTATION_GRACE_MS);
    return displayRotation ? { displayRotation } : {};
  } finally {
    probeController.abort();
  }
}

async function settledWithin<T>(pending: Promise<T>, graceMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureAndroidScreenshot(device: DeviceInfo, outPath: string): Promise<void> {
  const result = await runAndroidExecOut(device, ['screencap', '-p'], {
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

  await requireAndroidAdbHost().files.writeBytes(
    outPath,
    result.stdoutBuffer.subarray(pngOffset, pngEndOffset),
  );
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
