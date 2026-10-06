import crypto from 'node:crypto';
import {
  BROWSERSTACK_CREDENTIAL_VARIABLES,
  CLOUD_WEBDRIVER_PROVIDERS,
  readBrowserStackCredentials,
} from '@agent-device/provider-webdriver/providers';
import type { LIMRUN_PROVIDER } from '@agent-device/provider-limrun';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { readLimrunCredentialValues } from './provider-limrun-credentials.ts';

type CredentialValues = Readonly<Record<string, string | undefined>>;

// Each provider's own reader, so the fingerprint sees exactly the values the provider uses. AWS
// Device Farm is absent: it reads the AWS CLI credential chain, which no env hash identifies.
const PROVIDER_CREDENTIAL_READERS: ReadonlyMap<
  string,
  (env: EnvMap, leaseBackend?: string) => CredentialValues
> = new Map([
  ['limrun' satisfies typeof LIMRUN_PROVIDER, readLimrunCredentialValues],
  [
    CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    (env: EnvMap): CredentialValues => {
      const { username, accessKey } = readBrowserStackCredentials(env);
      return {
        [BROWSERSTACK_CREDENTIAL_VARIABLES.username]: username,
        [BROWSERSTACK_CREDENTIAL_VARIABLES.accessKey]: accessKey,
      };
    },
  ],
]);

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
  return read ? digest(read(env, leaseBackend)) : undefined;
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
