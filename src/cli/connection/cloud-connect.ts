import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import {
  readRemoteConnectionState,
  removeRemoteConnectionState,
  type CloudSessionBinding,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { AppError, asAppError, errorMessage } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
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
  CLOUD_CONNECTION_REASONS,
  prepareCloudConnection,
  readProxyFrontAttachment,
  removeCloudAttachment,
  removeCloudConnection,
  writeCloudConnection,
  type CloudConnectionRecord,
  type ConnectionLocation,
} from './cloud-connection-record.ts';
import { stopHostedLimrunDaemon } from './cloud-limrun.ts';
import { releaseProxyFrontConnectionLease } from '../commands/connection-lease-transaction.ts';
import {
  hostedCloudAccountBinding,
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
  try {
    const session = await createCloudSession(access, request, cloudAttempt(location, record));
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
      await cleanRejectedConnection(location, record, access, error, attaching);
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
  } else if (!(await confirmsRejectedAllocation(access, record, error))) {
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
    record.accountBinding !== undefined &&
    record.accountBinding === hostedCloudAccountBinding(access)
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

async function lookupRecordedAllocation(access: HostedCloudAccess, record: CloudConnectionRecord) {
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
  // The lease release needs the attachment token, so it runs before the attachment is removed. A
  // failed release does not stop teardown: the attachment and its token are removed either way,
  // and a proxy front ends a lease whose heartbeats stop once its TTL passes.
  const leaseReleaseError = await releaseProxyFrontTeardownLease(client, location, state);
  markCloudConnectionClosing(location, record);
  removeCloudAttachment(location);
  const daemonGeneration =
    binding?.transport === 'agent-device-daemon' ? undefined : (record ?? binding)?.generation;
  const retirementFailure = await stopHostedLimrunDaemon(location, daemonGeneration, host).then(
    () => undefined,
    (error: unknown) => error,
  );
  const releasedId = await releaseBrokerSession({ location, record, host, binding }).catch(
    (error: unknown) => {
      if (!retirementFailure) throw error;
      const retirement = asAppError(retirementFailure, 'COMMAND_FAILED');
      const broker = asAppError(error, 'COMMAND_FAILED');
      throw new AppError(retirement.code, retirement.message, {
        ...retirement.details,
        brokerReleaseReason: broker.details?.reason ?? broker.code,
      });
    },
  );
  if (retirementFailure) {
    if (releasedId && record) {
      record.brokerReleased = true;
      writeCloudConnection(location, record);
    }
    throw retirementFailure;
  }
  await stopMetroCleanup(binding ? state?.metro : undefined);
  removeCloudState(location, state, record);
  return { cloudSessionId: releasedId ?? record?.id, leaseReleaseError };
}

async function releaseBrokerSession(options: {
  location: ConnectionLocation;
  record: CloudConnectionRecord | null;
  host: HostEnvironment;
  binding?: CloudSessionBinding;
}): Promise<string | undefined> {
  const { location, record, host, binding } = options;
  if (record?.brokerReleased) return undefined;
  const access = await resolveHostedCloudAccess({
    env: host.env,
    stateDir: location.stateDir,
    interactive: false,
    savedOrigin: record?.origin ?? binding?.baseUrl,
  });
  const id = await cloudSessionIdForRelease(access, location, record, binding?.id);
  if (id) await deleteCloudSession(access, id);
  return id;
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

async function cloudSessionIdForRelease(
  access: HostedCloudAccess,
  location: ConnectionLocation,
  record: CloudConnectionRecord | null,
  bindingId: string | undefined,
): Promise<string | undefined> {
  const id = record?.id ?? bindingId;
  if (!record) return id;
  requireMatchingAccount(access, record);
  if (id && record.accountBinding !== undefined) return id;
  const found = await lookupRecordedAllocation(access, record);
  if (!found.active) return undefined;
  record.accountBinding ??= hostedCloudAccountBinding(access);
  record.id = found.id;
  writeCloudConnection(location, record);
  return found.id;
}

export async function forgetCloudConnection(options: {
  location: ConnectionLocation;
  state: RemoteConnectionState | null;
  record: CloudConnectionRecord | null;
  host: HostEnvironment;
}): Promise<void> {
  const { location, state, record, host } = options;
  const binding = cloudBindingForTeardown(location, state, record);
  if (binding?.transport !== 'agent-device-daemon') {
    await stopHostedLimrunDaemon(location, (record ?? binding)?.generation, host);
  }
  await stopMetroCleanup(binding ? state?.metro : undefined);
  removeCloudAttachment(location);
  removeCloudState(location, state, record);
  removeCloudConnection(location);
}

function removeCloudState(
  location: ConnectionLocation,
  state: RemoteConnectionState | null,
  record: CloudConnectionRecord | null,
): void {
  if (!state?.cloudSession || (record && state.cloudSession.generation !== record.generation))
    return;
  removeRemoteConnectionState(location);
  removeGeneratedRemoteConfigIfUnused({
    stateDir: location.stateDir,
    remoteConfigPath: state.remoteConfigPath,
  });
}
