import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import { ROUTING_PROVIDER_IDENTITIES } from '@agent-device/plugins/contract';
import { LIMRUN_CONNECTION_CAPABILITIES } from '@agent-device/provider-limrun/internal';

export const LIMRUN_ID = 'limrun';

/** Every provider id agent-device registers itself; a plugin cannot claim any of them. */
export const BUILTIN_PROVIDER_IDS: readonly string[] = [LIMRUN_ID];

/** Provider ids `connect` accepts without a plugin: the routing identities and the built-ins. */
export const BUILTIN_CONNECT_PROVIDER_IDS: readonly string[] = [
  ...ROUTING_PROVIDER_IDENTITIES,
  ...BUILTIN_PROVIDER_IDS,
];

/**
 * The built-in provider's connect capabilities, read without loading its implementation. The
 * provider package declares what its lease is; this names which built-in answers with that
 * declaration, so a synchronous routing read never has to load the plugin registry.
 */
export function builtinConnectionCapabilities(
  provider: string | undefined,
): ConnectionProviderCapabilities | undefined {
  return provider === LIMRUN_ID ? LIMRUN_CONNECTION_CAPABILITIES : undefined;
}
