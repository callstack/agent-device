import crypto from 'node:crypto';
import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';
import {
  pluginCredentialVariables,
  type PluginInventoryEntry,
} from '@agent-device/contracts/plugin-inventory';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { legacyStoreManifests } from '@agent-device/plugins/store';

type CredentialValues = Readonly<Record<string, string | undefined>>;

/**
 * A versioned, non-reversible digest of the credentials a lease on `leaseBackend` reads from `env`,
 * or undefined when `env` holds none of them or the provider's credentials do not come from the
 * environment. Variable names come from the daemon's plugin inventory, then from v1 manifests.
 */
export function providerCredentialFingerprint(
  provider: string,
  env: EnvMap,
  leaseBackend?: string,
  inventory?: readonly PluginInventoryEntry[],
): string | undefined {
  const variables = declaredCredentialVariables(provider, env, leaseBackend, inventory);
  // Whitespace-only counts as unset and other values are kept as is, as the provider's requireEnv does.
  return variables
    ? digest(
        Object.fromEntries(
          variables.map((name) => [name, env[name]?.trim() ? env[name] : undefined]),
        ),
      )
    : undefined;
}

// Read from the inventory or manifest, so neither the client nor the daemon evaluates provider code.
function declaredCredentialVariables(
  provider: string,
  env: EnvMap,
  leaseBackend: string | undefined,
  inventory: readonly PluginInventoryEntry[] | undefined,
): readonly string[] | undefined {
  const published = inventory && pluginCredentialVariables(inventory, provider, leaseBackend);
  if (published) return published;
  return legacyStoreManifests(env).find((plugin) => plugin.agentDevicePlugin.provider === provider)
    ?.agentDevicePlugin.credentialVariables;
}

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

function digest(values: CredentialValues): string | undefined {
  const pairs = Object.entries(values)
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (pairs.length === 0) return undefined;
  const hash = crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
  return `v1:${hash.slice(0, 16)}`;
}
