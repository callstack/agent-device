import crypto from 'node:crypto';
import { cloudWebDriverProviderDeclaration } from '@agent-device/provider-webdriver/providers';
import type { LIMRUN_PROVIDER } from '@agent-device/provider-limrun';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { readLimrunCredentialValues } from './provider-limrun-credentials.ts';
import { RESERVED_PLUGIN_PROVIDERS } from './plugins/manifest.ts';
import { installedPlugins } from './plugins/store.ts';

type CredentialValues = Readonly<Record<string, string | undefined>>;

// Limrun's reader narrows the variables to the leased platform; every other provider declares a
// flat variable list, bundled or installed.
const PROVIDER_CREDENTIAL_READERS: ReadonlyMap<
  string,
  (env: EnvMap, leaseBackend?: string) => CredentialValues
> = new Map([['limrun' satisfies typeof LIMRUN_PROVIDER, readLimrunCredentialValues]]);

/**
 * A versioned, non-reversible digest of the credentials a lease on `leaseBackend` reads from `env`,
 * or undefined when `env` holds none of them or the provider's credentials do not come from the
 * environment.
 */
export function providerCredentialFingerprint(
  provider: string,
  env: EnvMap,
  leaseBackend?: string,
): string | undefined {
  const read = PROVIDER_CREDENTIAL_READERS.get(provider);
  if (read) return digest(read(env, leaseBackend));
  // Whitespace-only counts as unset and other values are kept as is, as the provider's requireEnv does.
  const variables = declaredCredentialVariables(provider, env);
  return variables
    ? digest(
        Object.fromEntries(
          variables.map((name) => [name, env[name]?.trim() ? env[name] : undefined]),
        ),
      )
    : undefined;
}

// Read from the declaration or manifest, so neither the client nor the daemon evaluates provider code.
function declaredCredentialVariables(provider: string, env: EnvMap): readonly string[] | undefined {
  if ((RESERVED_PLUGIN_PROVIDERS as readonly string[]).includes(provider))
    return cloudWebDriverProviderDeclaration(provider)?.credentialVariables;
  return installedPlugins(env).find((plugin) => plugin.agentDevicePlugin.provider === provider)
    ?.agentDevicePlugin.credentialVariables;
}

/** The provider credentials a daemon started with, and the state dir that names that daemon. */
export type DaemonProviderCredentials = Readonly<{
  /** Undefined when the daemon's environment holds none of the credentials such a lease reads. */
  fingerprint(provider: string, leaseBackend?: string): string | undefined;
  stateDir: string;
}>;

export function readDaemonProviderCredentials(
  env: EnvMap,
  stateDir: string,
): DaemonProviderCredentials {
  const startupEnv = { ...env };
  return {
    fingerprint: (provider, leaseBackend) =>
      providerCredentialFingerprint(provider, startupEnv, leaseBackend),
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
