import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import type {
  ScreenshotCaptureCapabilities,
  ScreenshotOptions,
} from '@agent-device/contracts/screenshot-runtime';

export function appleScreenshotCaptureCapabilities(
  device: DeviceInfo,
  options: Pick<ScreenshotOptions, 'captureBackend'>,
): ScreenshotCaptureCapabilities {
  return {
    screenMask: isHandheldAppleSimulator(device) && options.captureBackend !== 'runner',
  };
}
