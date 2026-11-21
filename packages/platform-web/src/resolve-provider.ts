import type { WebProvider } from '@agent-device/contracts/web-provider';
import type { WebToolbox } from './toolbox.ts';

/**
 * The provider a web request composed for itself, or `undefined` outside one. A reader that must
 * not touch the default browser session (network dump, audio probe, recording) answers from this
 * alone: an unscoped provider would read that default session instead of the request's.
 */
export async function resolveRequestScopedWebProvider(): Promise<WebProvider | undefined> {
  const { hasScopedWebProvider, resolveWebProvider } = await import('./provider.ts');
  return hasScopedWebProvider() ? resolveWebProvider() : undefined;
}

/**
 * The one policy for the provider of a web request: a request-scoped provider wins; a request
 * that reaches a web device with no composed provider gets the agent-browser provider bound to
 * the host the plugin was set up with. Every reader of one web request resolves through this
 * module so they agree on one provider (#3794): the interactor takes this fallback, while the
 * readers that must stay on the request's own browser session use
 * {@link resolveRequestScopedWebProvider}.
 */
export async function resolveWebProviderForToolbox(
  toolbox: WebToolbox,
  provider?: WebProvider,
  stateDir?: string,
): Promise<WebProvider> {
  if (provider) return provider;
  const scoped = await resolveRequestScopedWebProvider();
  if (scoped) return scoped;
  const { createAgentBrowserWebProvider } = await import('./agent-browser-provider.ts');
  return await createAgentBrowserWebProvider({ toolbox, stateDir });
}
