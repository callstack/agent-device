import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import { ROUTING_PROVIDER_IDENTITIES } from '@agent-device/plugins/contract';

export const LIMRUN_ID = 'limrun';

const LIMRUN_CONNECTION: ConnectionProviderCapabilities = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: false,
  supportsDeferredAppSelection: true,
  supportsDirectPortReverse: true,
  usesCloudWebDriverLease: false,
  holdsCloudDevice: true,
  forgetsEndedConnectionLease: true,
};

/** Every provider id agent-device registers itself; a plugin cannot claim any of them. */
export const BUILTIN_PROVIDER_IDS: readonly string[] = [LIMRUN_ID];

/** Provider ids `connect` accepts without a plugin: the routing identities and the built-ins. */
export const BUILTIN_CONNECT_PROVIDER_IDS: readonly string[] = [
  ...ROUTING_PROVIDER_IDENTITIES,
  ...BUILTIN_PROVIDER_IDS,
];

/** The built-in provider's connect capabilities, read without loading its implementation. */
export function builtinConnectionCapabilities(
  provider: string | undefined,
): ConnectionProviderCapabilities | undefined {
  return provider === LIMRUN_ID ? LIMRUN_CONNECTION : undefined;
}
