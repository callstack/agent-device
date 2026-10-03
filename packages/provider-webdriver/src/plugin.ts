import type { CloudWebDriverRuntimeOptions, CloudWebDriverRuntime } from './runtime.ts';

export async function createCloudWebDriverRuntime(
  options: CloudWebDriverRuntimeOptions,
): Promise<CloudWebDriverRuntime> {
  const runtime = await import('./runtime.ts');
  return runtime.createCloudWebDriverRuntime(options);
}
export type { CloudWebDriverRuntimeOptions } from './runtime.ts';
