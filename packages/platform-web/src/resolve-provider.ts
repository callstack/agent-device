import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { WebProvider } from './provider.ts';

/**
 * The one policy for the provider of a web request: a request-scoped provider wins; a request
 * that reaches a web device with no composed provider gets the agent-browser provider bound to
 * the composing runtime's host. Every reader of one web request — the interactor, the network
 * transport, the audio probe — resolves through here, so they always agree on one provider
 * (#3794).
 */
export async function resolveWebProviderForHost(
  host: HostEnvironment,
  provider?: WebProvider,
): Promise<WebProvider> {
  if (provider) return provider;
  const [{ hasScopedWebProvider, resolveWebProvider }, { createAgentBrowserWebProvider }] =
    await Promise.all([import('./provider.ts'), import('./agent-browser-provider.ts')]);
  return (await hasScopedWebProvider())
    ? resolveWebProvider()
    : await createAgentBrowserWebProvider({ host });
}
