import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { providerCredentialFingerprint } from '@agent-device/plugins/credential-fingerprint';

export function readDaemonProviderCredentials(
  env: EnvMap,
  stateDir: string,
  inventory: readonly PluginInventoryEntry[],
): DaemonProviderCredentials {
  const startupEnv = { ...env };
  return {
    fingerprint: (provider, leaseBackend) =>
      providerCredentialFingerprint(provider, startupEnv, leaseBackend, inventory),
    stateDir,
  };
}
