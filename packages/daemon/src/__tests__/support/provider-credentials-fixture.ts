import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';

/**
 * The `DaemonProviderCredentials` port as the daemon suites need it. The daemon only compares
 * the fingerprint a client reports against the one this port computes from the daemon's startup
 * environment — the fingerprints are opaque to daemon policy, which asserts refusal, reuse, and
 * passthrough, never fingerprint content. So the fake builds a deterministic opaque key from
 * the sorted defined pairs rather than reproducing the real reader's digest format (the real
 * provider/manifest-aware selection and digest semantics are pinned root-owned in
 * request-router-provider-credentials and provider-credential-fingerprint). Distinct environments
 * produce distinct keys and an empty environment produces `undefined` — the whole contract the
 * daemon suites observe.
 */
export function providerCredentialsFixture(
  env: Readonly<Record<string, string | undefined>> = {},
  stateDir = '/tmp',
): DaemonProviderCredentials {
  const startupEnv = { ...env };
  return {
    fingerprint: () => opaqueFingerprint(startupEnv),
    stateDir,
  };
}

function opaqueFingerprint(
  values: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const pairs = Object.entries(values)
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return pairs.length === 0 ? undefined : JSON.stringify(pairs);
}
