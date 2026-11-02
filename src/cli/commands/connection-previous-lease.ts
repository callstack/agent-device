import {
  buildRemoteConnectionDaemonState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { readRemoteConfigFile } from '@agent-device/remote/remote-config-core';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import type { PreviousLeaseReleaseNotice } from './connection-presentation.ts';
import {
  isHostAllocatedLease,
  releaseRemoteConnectionLease,
} from './connection-lease-transaction.ts';

// A forced reconnect releases the *previous* connection's lease, which must be
// authenticated against the *previous* endpoint's own credential — never the
// new connection's token (that would send an unrelated endpoint's secret to
// an endpoint it was never issued for). See plans/007 for the full rule.
type PreviousLeaseAuthResolution =
  | { canAuthenticate: true; daemonAuthToken?: string }
  | { canAuthenticate: false };

function resolvePreviousLeaseAuth(options: {
  previous: RemoteConnectionState;
  nextDaemonBaseUrl?: string;
  ambientDaemonAuthToken?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): PreviousLeaseAuthResolution {
  const ownToken = resolvePreviousOwnDaemonAuthToken(options.previous, options.cwd, options.env);
  if (ownToken) return { canAuthenticate: true, daemonAuthToken: ownToken };
  if (options.previous.daemon?.baseUrl === options.nextDaemonBaseUrl) {
    // Same endpoint: the ambient credential plausibly belongs to it too.
    return { canAuthenticate: true, daemonAuthToken: options.ambientDaemonAuthToken };
  }
  return { canAuthenticate: false };
}

function resolvePreviousOwnDaemonAuthToken(
  previous: RemoteConnectionState,
  cwd: string,
  env: Record<string, string | undefined>,
): string | undefined {
  try {
    // readRemoteConfigFile, not resolveRemoteConfigProfile: the latter merges
    // ambient environment defaults (e.g. AGENT_DEVICE_DAEMON_AUTH_TOKEN) into
    // the profile, which would let the *new* connection's env-sourced token
    // masquerade as a credential that provably belongs to the *previous*
    // endpoint. Only a token the previous config file itself declares counts
    // here; the env fallback is rule 2's job, gated on matching endpoints.
    const { profile } = readRemoteConfigFile({
      configPath: previous.remoteConfigPath,
      cwd,
      env,
    });
    if (!profile.daemonAuthToken) return undefined;
    // The path alone is not provenance. `remoteConfigPath` names a file *now*,
    // while the claim being made is about what that file declared when the
    // previous connection was established — and a config path is routinely
    // reused (edited in place, re-pointed at a second environment) between the
    // two. Without this check, "connect to A from ./remote.json, re-point
    // ./remote.json at B, connect --force" reads B's token as A's own and
    // sends it to A during lease release: the same cross-endpoint leak the
    // env-merge fix closed, arriving through the file instead.
    return previousConfigStillSpeaksForPreviousEndpoint(previous, profile.daemonBaseUrl)
      ? profile.daemonAuthToken
      : undefined;
  } catch {
    // A missing/unparseable previous config is the "cannot authenticate"
    // case handled by the caller, not an error to propagate here.
    return undefined;
  }
}

/**
 * Whether the previous connection's config file can still vouch for a token as
 * belonging to the previous connection's endpoint.
 *
 * The file must explicitly declare the same endpoint recorded in the previous
 * connection state. A matching file hash proves only that the file itself did
 * not change; it does not prove that its endpoint/token were effective when
 * CLI flags may have overridden them. Endpoint equality is the provenance
 * boundary and also preserves the benign rotated-credential case.
 *
 * The endpoint comparison runs both sides through
 * `buildRemoteConnectionDaemonState`, the same normalizer that produced the
 * stored `daemon.baseUrl`, so it compares like with like rather than raw
 * strings that differ only by a trailing slash.
 *
 * A file that changed and no longer declares an endpoint at all cannot vouch
 * for anything: the caller then falls back to rule 2 (matching endpoints) or
 * reports the lease as unreleasable, which is a warning and an orphaned lease
 * — the correct price for not sending a credential somewhere it may not belong.
 */
function previousConfigStillSpeaksForPreviousEndpoint(
  previous: RemoteConnectionState,
  declaredDaemonBaseUrl: string | undefined,
): boolean {
  const declared = buildRemoteConnectionDaemonState({
    daemonBaseUrl: declaredDaemonBaseUrl,
  })?.baseUrl;
  return declared !== undefined && declared === previous.daemon?.baseUrl;
}

export async function releasePreviousLease(
  client: AgentDeviceClient,
  previous: RemoteConnectionState,
  options: {
    nextDaemonBaseUrl?: string;
    ambientDaemonAuthToken?: string;
    cwd: string;
    env: Record<string, string | undefined>;
  },
): Promise<PreviousLeaseReleaseNotice | undefined> {
  if (!previous.leaseId || isHostAllocatedLease(previous)) return undefined;
  const auth = resolvePreviousLeaseAuth({
    previous,
    nextDaemonBaseUrl: options.nextDaemonBaseUrl,
    ambientDaemonAuthToken: options.ambientDaemonAuthToken,
    cwd: options.cwd,
    env: options.env,
  });
  if (!auth.canAuthenticate) {
    return buildUnreleasedPreviousLeaseNotice(
      previous,
      'no credential known to belong to that endpoint was available',
    );
  }
  try {
    await releaseRemoteConnectionLease(client, previous, auth.daemonAuthToken);
    return undefined;
  } catch {
    // Reconnect must still succeed; surface the failure instead of hiding it.
    return buildUnreleasedPreviousLeaseNotice(previous, 'the release request failed');
  }
}

function buildUnreleasedPreviousLeaseNotice(
  previous: RemoteConnectionState,
  reason: string,
): PreviousLeaseReleaseNotice {
  return {
    status: 'unreleased',
    message:
      `Could not release the previous lease ${previous.leaseId} ` +
      `(tenant ${previous.tenant}, run ${previous.runId}) ` +
      `at ${previous.daemon?.baseUrl ?? 'its daemon'}: ${reason}. ` +
      'It was left in place — release it manually if it is still active.',
  };
}
