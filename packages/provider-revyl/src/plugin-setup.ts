import type { ProviderPluginHost } from 'agent-device/plugins';
import type { RevylRuntimeRegistration } from './runtime.ts';

/**
 * Builds one host's Revyl runtime and the owner its bindings route through. Both plugin entries — the
 * version 2 declaration in `index.ts` and the version 1 packaged entry in `plugin.ts` — build the
 * runtime here, so the credential lookup and the construction have exactly one owner.
 *
 * This is the boundary the credentials are read at, in both entries. A host that only lists installed
 * plugins reads the package manifest and never gets here, so a machine with no key still sees Revyl in
 * `plugins list`; the key is owed only once the provider is actually set up.
 *
 * The modules are loaded rather than imported: a host that only reads the plugin's declaration must
 * not pay for the runtime graph.
 */
export async function setupRevylPlugin(
  host: ProviderPluginHost,
): Promise<RevylRuntimeRegistration> {
  const { requireRevylCredentials } = await import('./credentials.ts');
  const { createRevylRuntime } = await import('./runtime.ts');
  const credentials = requireRevylCredentials(host.env, 'Revyl plugin setup');
  return createRevylRuntime({
    apiKey: credentials.apiKey,
    ...(credentials.apiUrl === undefined ? {} : { backendUrl: credentials.apiUrl }),
    clientVersion: host.clientVersion,
  });
}
