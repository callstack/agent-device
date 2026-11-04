import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import type { MacOsHelperSurface } from '@agent-device/contracts/session';
import { resolveAppleToolProvider } from './core/tool-provider.ts';
import type {
  ScreenshotCaptureCapabilities,
  ScreenshotOptions,
} from '@agent-device/contracts/screenshot-runtime';

export function appleScreenshotCaptureCapabilities(
  device: DeviceInfo,
  options: Pick<ScreenshotOptions, 'captureBackend'>,
  helper?: MacOsHelperSurface,
): ScreenshotCaptureCapabilities {
  return {
    screenMask:
      isHandheldAppleSimulator(device) &&
      options.captureBackend !== 'runner' &&
      resolveAppleToolProvider().simulatorScreenshotBackend !== 'runner',
    runner: helper === undefined,
  };
}
