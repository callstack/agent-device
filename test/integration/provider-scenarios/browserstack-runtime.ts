import browserstack from '@agent-device/browserstack';
import { createPluginHost } from '@agent-device/plugins/host';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';

export const BROWSERSTACK_PROVIDER = 'browserstack';

export async function createBrowserStackRuntime(options: {
  env: Record<string, string>;
  clientVersion: string;
}) {
  const [contribution] = browserstack().contributes;
  const setup = await contribution.setup({
    ...(await createPluginHost({ env: options.env, cwd: '/' }, undefined)),
    clientVersion: options.clientVersion,
  });
  if (!('runtime' in setup)) throw new Error('BrowserStack setup needs an active runtime');
  const { runtime } = setup;
  return runtime as ProviderDeviceRuntime & {
    platformRuntimeModule: PlatformRuntimeProviderModule;
  };
}
