import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { writeHostBinaryFile } from '@agent-device/host-kit/host-file';
import { runIosDevicectl } from './devicectl.ts';
import { copyCoreDeviceRunnerFile } from './physical-device-files.ts';
import type { AppleRunnerCommandExecutor, AppleRunnerCommandOptions } from '../runner/index.ts';
import { appleToolFailureText, extractAppleToolErrorMeta } from './tool-diagnostics.ts';

export type IosPhysicalDeviceScreenshotOptions = {
  appBundleId?: string;
  fullscreen?: boolean;
  runnerOptions?: AppleRunnerCommandOptions;
  preferRunner?: boolean;
  runRunnerCommand: AppleRunnerCommandExecutor;
};

export async function captureCoreDeviceScreenshot(
  device: DeviceInfo,
  outPath: string,
  options: IosPhysicalDeviceScreenshotOptions,
): Promise<void> {
  if (!options.preferRunner) {
    try {
      await runIosDevicectl(
        ['device', 'capture', 'screenshot', '--device', device.id, '--destination', outPath],
        {
          action: 'capture iOS screenshot',
          deviceId: device.id,
        },
      );
      return;
    } catch (error) {
      if (!shouldFallbackToRunnerForIosScreenshot(error)) throw error;
      emitPhysicalScreenshotFallbackDiagnostic(device, error);
    }
  }

  const result = await runRunnerScreenshot(device, options, false);
  if (await writeInlineRunnerScreenshot(result, outPath)) return;

  const remoteFileName = readRunnerScreenshotPath(result);
  await copyCoreDeviceRunnerFile(device, remoteFileName, outPath);
}

export async function captureXctestDeviceScreenshot(
  device: DeviceInfo,
  outPath: string,
  options: IosPhysicalDeviceScreenshotOptions,
): Promise<void> {
  const result = await runRunnerScreenshot(device, options, true);
  if (await writeInlineRunnerScreenshot(result, outPath)) return;
  throw new AppError(
    'COMMAND_FAILED',
    'Failed to capture iOS screenshot: XCTest runner returned no inline image',
    {
      deviceId: device.id,
      backend: 'xctest',
    },
  );
}

async function runRunnerScreenshot(
  device: DeviceInfo,
  options: IosPhysicalDeviceScreenshotOptions,
  inlineScreenshot: boolean,
): Promise<Record<string, unknown>> {
  return await options.runRunnerCommand(
    device,
    {
      command: 'screenshot',
      appBundleId: options.appBundleId,
      fullscreen: options.fullscreen,
      inlineScreenshot,
    },
    options.runnerOptions ?? {},
  );
}

async function writeInlineRunnerScreenshot(
  result: Record<string, unknown>,
  outPath: string,
): Promise<boolean> {
  const inlineImage = result['imageBase64'];
  if (typeof inlineImage !== 'string' || inlineImage.length === 0) return false;
  await writeHostBinaryFile(outPath, Buffer.from(inlineImage, 'base64'));
  return true;
}

function readRunnerScreenshotPath(result: Record<string, unknown>): string {
  const remoteFileName = result['message'];
  if (typeof remoteFileName === 'string' && remoteFileName.length > 0) return remoteFileName;
  throw new AppError(
    'COMMAND_FAILED',
    'Failed to capture iOS screenshot: runner returned no file path',
  );
}

function emitPhysicalScreenshotFallbackDiagnostic(device: DeviceInfo, error: unknown): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_screenshot_fallback',
    data: {
      platform: device.platform,
      deviceKind: device.kind,
      deviceId: device.id,
      from: 'devicectl_screenshot',
      to: 'runner',
      ...extractAppleToolErrorMeta(error),
    },
  });
}

export function shouldFallbackToRunnerForIosScreenshot(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const combined = appleToolFailureText(error);
  return (
    combined.includes("unknown option '--device'") ||
    (combined.includes('unknown subcommand') && combined.includes('screenshot')) ||
    (combined.includes('unrecognized subcommand') && combined.includes('screenshot'))
  );
}
