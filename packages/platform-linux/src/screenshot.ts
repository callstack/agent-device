import type { ScreenshotOptions } from '@agent-device/contracts/interactor-types';
import type { LinuxToolProvider } from './tool-provider-types.ts';

export async function screenshotLinux(
  provider: LinuxToolProvider,
  outPath: string,
  options?: ScreenshotOptions,
): Promise<void> {
  await provider.screenshot.capture(outPath, options);
}
