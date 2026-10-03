import { resolveLinuxToolProvider, type LinuxScreenshotOptions } from './tool-provider.ts';

export async function screenshotLinux(
  outPath: string,
  options?: LinuxScreenshotOptions,
): Promise<void> {
  await resolveLinuxToolProvider().screenshot!.capture(outPath, options);
}
