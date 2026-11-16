import type { CloudWebDriverRuntimeOptions, CloudWebDriverRuntime } from './runtime.ts';

/**
 * The shared hosted-WebDriver engine. A provider plugin contributes the descriptor it drives
 * through `agent-device/plugins/webdriver`; this package keeps the engine and its helpers.
 */
export async function createCloudWebDriverRuntime(
  options: CloudWebDriverRuntimeOptions,
): Promise<CloudWebDriverRuntime> {
  const runtime = await import('./runtime.ts');
  return runtime.createCloudWebDriverRuntime(options);
}
