import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  readRemoteConnectionState,
  removeRemoteConnectionState,
  type CloudSessionBinding,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { AppError } from '@agent-device/kernel/errors';
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
  removeCloudAttachment,
  removeCloudConnection,
  writeCloudConnection,
  type CloudConnectionRecord,
  type ConnectionLocation,
} from './cloud-connection-record.ts';
import { stopHostedLimrunDaemon } from './cloud-limrun.ts';
import { resolveHostedCloudAccess, type HostedCloudAccess } from './cloud-access.ts';
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
  } else if (record.id || !isDefinitiveCloudCreateRejection(error)) {
    return;
  }
  removeCloudState(location, readRemoteConnectionState(location), record);
  removeCloudConnection(location);
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

export async function releaseCloudConnection(options: {
  location: ConnectionLocation;
  state: RemoteConnectionState | null;
  record: CloudConnectionRecord | null;
  host: HostEnvironment;
}): Promise<string | undefined> {
  const { location, state, record, host } = options;
  const binding = cloudBindingForTeardown(location, state, record);
  const access = record?.brokerReleased
    ? undefined
    : await resolveHostedCloudAccess({
        env: host.env,
        stateDir: location.stateDir,
        interactive: false,
        savedOrigin: record?.origin ?? binding?.baseUrl,
      });
  const id = access ? await cloudSessionIdForRelease(access, record, binding?.id) : record?.id;
  markCloudConnectionClosing(location, record);
  removeCloudAttachment(location);
  const retirementFailure = await stopHostedLimrunDaemon(location, binding, host).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (access && id) {
    await deleteCloudSession(access, id);
    if (retirementFailure && record) {
      record.brokerReleased = true;
      writeCloudConnection(location, record);
    }
  }
  if (retirementFailure) throw retirementFailure;
  await stopMetroCleanup(binding ? state?.metro : undefined);
  removeCloudState(location, state, record);
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
  record: CloudConnectionRecord | null,
  bindingId: string | undefined,
): Promise<string | undefined> {
  const id = record?.id ?? bindingId;
  if (id || !record) return id;
  const found = await lookupCloudSession(access, record.generation);
  if (!found?.active) return undefined;
  record.id = found.id;
  return found.id;
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
