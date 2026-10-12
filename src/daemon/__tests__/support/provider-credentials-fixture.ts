import crypto from 'node:crypto';
import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';

/**
 * The `DaemonProviderCredentials` port as the daemon suites need it. The daemon only compares
 * the fingerprint a client reports against the one this port computes from the daemon's startup
 * environment — the digests are opaque to daemon policy, which asserts refusal, reuse, and
 * passthrough, never digest content. The real reader's provider/manifest-aware variable
 * selection and digest semantics are pinned root-owned (request-router-provider-credentials,
 * lease-provider-credentials). This fixture digests the whole given environment so distinct
 * environments produce distinct fingerprints and an empty environment produces `undefined` —
 * the whole contract the daemon suites observe, without reading provider declarations.
 */
export function providerCredentialsFixture(
  env: Readonly<Record<string, string | undefined>> = {},
  stateDir = '/tmp',
): DaemonProviderCredentials {
  const startupEnv = { ...env };
  return {
    fingerprint: () => digest(startupEnv),
    stateDir,
  };
}

function digest(values: Readonly<Record<string, string | undefined>>): string | undefined {
  const pairs = Object.entries(values)
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (pairs.length === 0) return undefined;
  const hash = crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
  return `v1:${hash.slice(0, 16)}`;
}
