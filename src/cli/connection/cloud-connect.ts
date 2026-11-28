import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import {
  readRemoteConnectionState,
  removeRemoteConnectionState,
  type CloudSessionBinding,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { settleWithin } from '@agent-device/host-kit/settle-within';
import {
  createCloudSession,
  deleteCloudSession,
  isDefinitiveCloudCreateRejection,
  lookupCloudSession,
  type CloudSessionRequest,
  type CreatedCloudSession,
} from './cloud-session-api.ts';
import {
  assertCloudRecordSession,
  cloudConnectionUnavailable,
  CLOUD_CONNECTION_FORGET_HINT,
  CLOUD_CONNECTION_REASONS,
  admitCloudConnectionFilesForForget,
  prepareCloudConnection,
  readProxyFrontAttachment,
  removeCloudAttachment,
  removeCloudConnection,
  writeCloudConnection,
  type CloudConnectionRecord,
  type ConnectionLocation,
} from './cloud-connection-record.ts';
import { cloudLimrunDaemonDir, stopHostedLimrunDaemon } from './cloud-limrun.ts';
import { isLegacyCloudProfile } from './active-connection.ts';
import { releaseProxyFrontConnectionLease } from '../commands/connection-lease-transaction.ts';
import {
  hostedCloudAccountBinding,
  matchesHostedCloudAccount,
  resolveHostedCloudAccess,
  type HostedCloudAccess,
} from './cloud-access.ts';
import { removeGeneratedRemoteConfigIfUnused } from './generated-config.ts';
import { stopMetroCleanup } from '../commands/connection-metro-runtime.ts';

export async function connectCloudSession<T>(options: {
  location: ConnectionLocation;
  pending: CloudConnectionRecord | null;
  request: CloudSessionRequest;
  access: HostedCloudAccess;
  attach: (
    session: CreatedCloudSession & { binding: CloudSessionBinding },
    commit: () => void,
  ) => Promise<T>;
}): Promise<T> {
  const { location, request, access, pending, attach } = options;
  const record = prepareCloudConnection(location.session, request, access.cloudBaseUrl, pending);
  if (pending) await recoverPendingAccount(access, record);
  else record.accountBinding = hostedCloudAccountBinding(access);
  writeCloudConnection(location, record);
  removeCloudAttachment(location);
  let attaching = false;
  let rejectedBeforeRetry = false;
  try {
    const session = await createCloudSession(access, request, {
      ...cloudAttempt(location, record),
      observeInitialRejection: () => {
        rejectedBeforeRetry = !pending;
      },
    });
    const binding = { ...session.binding, generation: record.generation };
    record.deadlineAt = session.binding.deadlineAt;
    writeCloudConnection(location, record);
    attaching = true;
    return await attach({ ...session, binding }, () => {
      writeCloudConnection(location, { ...record, phase: 'committed' });
      record.phase = 'committed';
    });
  } catch (error) {
    if (record.phase !== 'committed') {
      await cleanRejectedConnection(
        location,
        record,
        access,
        error,
        attaching,
        rejectedBeforeRetry,
      );
    }
    throw error;
  }
}

async function cleanRejectedConnection(
  location: ConnectionLocation,
  record: CloudConnectionRecord,
  access: HostedCloudAccess,
  error: unknown,
  attaching: boolean,
  rejectedBeforeRetry: boolean,
): Promise<void> {
  if (attaching || invalidCreatedSession(error)) {
    if (!record.id) return;
    markCloudConnectionClosing(location, record);
    removeCloudAttachment(location);
    try {
      await deleteCloudSession(access, record.id);
    } catch {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.rollbackFailed.reason);
    }
  } else if (!rejectedBeforeRetry && !(await confirmsRejectedAllocation(access, record, error))) {
    return;
  }
  removeCloudState(location, readRemoteConnectionState(location), record);
  removeCloudConnection(location);
}

async function confirmsRejectedAllocation(
  access: HostedCloudAccess,
  record: CloudConnectionRecord,
  error: unknown,
): Promise<boolean> {
  if (
    record.id ||
    !sameHostedAccount(record, access) ||
    !isDefinitiveCloudCreateRejection(error) ||
    (error instanceof AppError && error.details?.status === 429)
  ) {
    return false;
  }
  try {
    const found = await lookupCloudSession(access, record.generation);
    return found?.active === false;
  } catch {
    return false;
  }
}

function sameHostedAccount(record: CloudConnectionRecord, access: HostedCloudAccess): boolean {
  return (
    record.accountBinding !== undefined && matchesHostedCloudAccount(access, record.accountBinding)
  );
}

async function recoverPendingAccount(
  access: HostedCloudAccess,
  record: CloudConnectionRecord,
): Promise<void> {
  requireMatchingAccount(access, record);
  if (record.accountBinding !== undefined) return;
  const found = await lookupRecordedAllocation(access, record);
  record.id = found.id;
  record.accountBinding = hostedCloudAccountBinding(access);
}

function requireMatchingAccount(access: HostedCloudAccess, record: CloudConnectionRecord): void {
  if (record.accountBinding !== undefined && !sameHostedAccount(record, access)) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialMismatch.reason);
  }
}

async function lookupRecordedAllocation(
  access: HostedCloudAccess,
  record: Pick<CloudConnectionRecord, 'generation' | 'id' | 'accountBinding'>,
) {
  const found = await lookupCloudSession(access, record.generation).catch((error: unknown) => {
    if (
      record.accountBinding !== undefined &&
      !(error instanceof AppError && error.details?.status === 404)
    ) {
      throw error;
    }
    return undefined;
  });
  if (!found || (record.id !== undefined && record.id !== found.id)) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.allocationUnconfirmed.reason);
  }
  return found;
}

function invalidCreatedSession(error: unknown) {
  const details = error instanceof AppError ? error.details : undefined;
  return (
    details?.status === undefined &&
    (details?.reason === 'cloud_session_invalid' ||
      details?.reason === 'cloud_transport_unsupported')
  );
}

function cloudAttempt(location: ConnectionLocation, record: CloudConnectionRecord) {
  return {
    key: record.generation,
    observeId: (id: string) => {
      if (record.id === id) return;
      if (record.id) throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.idChanged.reason);
      record.id = id;
      writeCloudConnection(location, record);
    },
  };
}

function markCloudConnectionClosing(
  location: ConnectionLocation,
  record: CloudConnectionRecord | null,
): void {
  if (!record) return;
  record.phase = 'closing';
  writeCloudConnection(location, record);
}

export type CloudConnectionRelease = {
  cloudSessionId?: string;
  /** Set when a proxy front did not confirm its lease release. Its lease ends by TTL instead. */
  leaseReleaseError?: string;
};

/** Returns the release failure to report, if any. A front without state has no lease id to release. */
async function releaseProxyFrontTeardownLease(
  client: AgentDeviceClient,
  location: ConnectionLocation,
  state: RemoteConnectionState | null,
): Promise<string | undefined> {
  const proxyFront = readProxyFrontAttachment(location);
  if (!proxyFront) return undefined;
  if (!state) {
    emitDiagnostic({
      level: 'warn',
      phase: 'proxy_front_attachment_without_state',
      data: { session: location.session },
    });
    return undefined;
  }
  try {
    const release = await releaseProxyFrontConnectionLease(client, state, proxyFront);
    return state.leaseId && !release.released && !release.absent
      ? 'the proxy front did not confirm the lease release'
      : undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

export async function releaseCloudConnection(options: {
  client: AgentDeviceClient;
  location: ConnectionLocation;
  state: RemoteConnectionState | null;
  record: CloudConnectionRecord | null;
  host: HostEnvironment;
}): Promise<CloudConnectionRelease> {
  const { client, location, state, record, host } = options;
  const binding = cloudBindingForTeardown(location, state, record);
  const brokerRelease = await verifyBrokerRelease({ location, record, host, binding });
  const releasedId = await releaseBrokerSession(brokerRelease);
  if (releasedId && record) {
    record.brokerReleased = true;
    // Keep proof of the release even if the subsequent closing transition fails.
    try {
      writeCloudConnection(location, record);
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'hosted_release_proof_write_retry',
        data: { error: errorMessage(error) },
      });
      try {
        writeCloudConnection(location, record);
      } catch (retryError) {
        throw new AppError(
          'COMMAND_FAILED',
          'Could not save confirmation that the hosted broker ended the session.',
          { hint: CLOUD_CONNECTION_FORGET_HINT, retryWriteError: errorMessage(retryError) },
          error,
        );
      }
    }
  }
  markCloudConnectionClosing(location, record);
  // The lease release needs the attachment token. If it fails, the front ends the lease by TTL.
  const leaseReleaseError = await releaseProxyFrontTeardownLease(client, location, state);
  removeCloudAttachment(location);
  const daemonGeneration =
    binding?.transport === 'agent-device-daemon' ? undefined : (record ?? binding)?.generation;
  await stopHostedLimrunDaemon(location, daemonGeneration, host);
  await stopMetroCleanup(binding ? state?.metro : undefined);
  removeCloudState(location, state, record);
  return { cloudSessionId: releasedId ?? record?.id, leaseReleaseError };
}

type VerifiedBrokerRelease = { access: HostedCloudAccess; id: string; active: boolean };

async function verifyBrokerRelease(options: {
  location: ConnectionLocation;
  record: CloudConnectionRecord | null;
  host: HostEnvironment;
  binding?: CloudSessionBinding;
}): Promise<VerifiedBrokerRelease | undefined> {
  const { location, record, host, binding } = options;
  const allocation = record ?? binding;
  if (!allocation || record?.brokerReleased) return undefined;
  const access = await resolveHostedCloudAccess({
    env: host.env,
    stateDir: location.stateDir,
    interactive: false,
    savedOrigin: record?.origin ?? binding?.baseUrl,
  }).catch((error: unknown) => {
    if (record || !(error instanceof AppError) || error.code !== 'UNAUTHORIZED') throw error;
    const authHint = error.details?.hint;
    throw new AppError(
      error.code,
      error.message,
      {
        ...error.details,
        hint: authHint
          ? `${authHint} ${CLOUD_CONNECTION_FORGET_HINT}`
          : CLOUD_CONNECTION_FORGET_HINT,
      },
      error,
    );
  });
  if (record) {
    requireMatchingAccount(access, record);
    if (record.id && record.accountBinding !== undefined) {
      return { access, id: record.id, active: true };
    }
  }
  const found = await lookupRecordedAllocation(access, allocation);
  if (record) {
    record.accountBinding ??= hostedCloudAccountBinding(access);
    record.id = found.id;
  }
  return { access, ...found };
}

async function releaseBrokerSession(target: VerifiedBrokerRelease | undefined) {
  if (target?.active) {
    try {
      await deleteCloudSession(target.access, target.id);
    } catch (error) {
      const failure =
        error instanceof AppError
          ? error
          : new AppError(
              'COMMAND_FAILED',
              'Could not confirm that the hosted broker ended the session.',
              undefined,
              error,
            );
      const retry = failure.details?.hint ?? 'Retry agent-device disconnect.';
      failure.details = { ...failure.details, hint: `${retry} ${CLOUD_CONNECTION_FORGET_HINT}` };
      throw failure;
    }
  }
  return target?.id;
}

function cloudBindingForTeardown(
  location: ConnectionLocation,
  state: RemoteConnectionState | null,
  record: CloudConnectionRecord | null,
): CloudSessionBinding | undefined {
  if (record) assertCloudRecordSession(location, record);
  if (state && state.session !== location.session) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.sessionMismatch.reason);
  }
  const binding = state?.cloudSession;
  if (binding && record && (binding.generation !== record.generation || binding.id !== record.id)) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.changed.reason);
  }
  return binding;
}

const FORGET_TEARDOWN_TIMEOUT_MS = 1000;

export async function forgetCloudConnection(options: {
  client: AgentDeviceClient;
  location: ConnectionLocation;
  state: RemoteConnectionState | null;
  host: HostEnvironment;
}): Promise<{ daemonStateDir?: string } | null> {
  const { client, location, state, host } = options;
  const hasFiles = admitCloudConnectionFilesForForget(location);
  const binding = cloudBindingForTeardown(location, state, null);
  const hostedState =
    state && (binding || isLegacyCloudProfile(location.stateDir, state.remoteConfigPath))
      ? state
      : null;
  if (!hasFiles && !hostedState) return null;
  const [daemonStateDir] = await Promise.all([
    stopHostedDaemonForForget(location, binding, host),
    binding?.transport === 'agent-device-daemon'
      ? settleWithin(
          () => releaseProxyFrontTeardownLease(client, location, hostedState),
          FORGET_TEARDOWN_TIMEOUT_MS,
        )
      : undefined,
    settleWithin(() => stopMetroCleanup(hostedState?.metro), FORGET_TEARDOWN_TIMEOUT_MS).catch(
      () => undefined,
    ),
  ]);
  removeCloudAttachment(location);
  if (hostedState) removeSavedCloudProfile(location, hostedState);
  removeCloudConnection(location);
  return { daemonStateDir };
}

async function stopHostedDaemonForForget(
  location: ConnectionLocation,
  binding: CloudSessionBinding | undefined,
  host: HostEnvironment,
): Promise<string | undefined> {
  if (binding?.transport !== 'limrun') return undefined;
  const stopped = await settleWithin(
    () => stopHostedLimrunDaemon(location, binding.generation, host),
    FORGET_TEARDOWN_TIMEOUT_MS,
  ).then(
    (result) => result.kind === 'settled',
    () => false,
  );
  if (!stopped) return cloudLimrunDaemonDir(location, binding);
}

function removeCloudState(
  location: ConnectionLocation,
  state: RemoteConnectionState | null,
  record: CloudConnectionRecord | null,
): void {
  if (!state?.cloudSession || (record && state.cloudSession.generation !== record.generation))
    return;
  removeSavedCloudProfile(location, state);
}

function removeSavedCloudProfile(location: ConnectionLocation, state: RemoteConnectionState): void {
  removeRemoteConnectionState(location);
  removeGeneratedRemoteConfigIfUnused({
    stateDir: location.stateDir,
    remoteConfigPath: state.remoteConfigPath,
  });
}
