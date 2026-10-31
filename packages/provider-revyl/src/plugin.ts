import type { ProviderPluginHost } from 'agent-device/plugins';
import type { RevylConnection } from './connection.ts';
import type { RevylRuntimeRegistration } from './runtime.ts';

/** What the version 1 host reads out of this entry: the runtime pair, plus the connect half. */
export type RevylPluginEntryResult = RevylRuntimeRegistration & {
  connection: RevylConnection;
};

/**
 * The version 1 plugin entry, kept so hosts without the version 2 contract still load this package.
 * The runtime is built by the same setup the version 2 declaration runs.
 */
export default async function revylPlugin(
  host: ProviderPluginHost,
): Promise<RevylPluginEntryResult> {
  const { setupRevylPlugin } = await import('./plugin-setup.ts');
  const { createRevylConnection } = await import('./connection.ts');
  const registration = await setupRevylPlugin(host);
  return { ...registration, connection: createRevylConnection(host) };
}
