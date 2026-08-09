import type { LogBackend } from '@agent-device/contracts/observability';
import {
  createDurableResourceEnvelope,
  decodeDurableResourceEnvelope,
  isConfirmedCleanup,
  runtimeOwnerKey,
  type AppLogCompletion,
  type AppLogLiveHandle,
  type CleanupOutcome,
  type DurableResourceEnvelope,
  type PendingTransferGuard,
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';
import { withAppLogResourceFence } from './app-log-resource-fence.ts';
import { readAppLogResourceRecord, writeAppLogResourceRecord } from './app-log-resource-store.ts';
import {
  blockUndurableAppLogCleanup,
  clearUndurableAppLogCleanup,
} from './app-log-start-preflight.ts';

export type AppLogSessionSnapshot = Readonly<{
  active: boolean;
  state: 'active' | 'recovering' | 'ended' | 'failed' | 'inactive';
  backend?: LogBackend;
  startedAt?: number;
  failureCode?: string;
  failureMessage?: string;
  hint?: string;
}>;

export function inspectSessionAppLog(session: SessionState): AppLogSessionSnapshot {
  if (session.appLog) {
    const snapshot = session.appLog.handle.inspect();
    return {
      active: snapshot.state === 'active' || snapshot.state === 'recovering',
      ...snapshot,
    };
  }
  if (session.appLogFailure) {
    return {
      active: false,
      state: 'failed',
      backend: session.appLogFailure.backend,
      failureCode: session.appLogFailure.code,
      failureMessage: session.appLogFailure.message,
      hint: session.appLogFailure.hint,
    };
  }
  return { active: false, state: 'inactive' };
}

type AdoptStartedSessionAppLogParams = {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  resourcePath: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<AppLogLiveHandle>;
  envelope: DurableResourceEnvelope<'app-log'>;
  throwIfCanceled(): void;
};

type AppLogAdoptionState = {
  persisted: boolean;
  transferredHandle?: AppLogLiveHandle;
};

export async function adoptStartedSessionAppLog(
  params: AdoptStartedSessionAppLogParams,
): Promise<void> {
  const state: AppLogAdoptionState = { persisted: false };
  try {
    adoptValidatedAppLogResource(params, state);
  } catch (error) {
    await recoverFailedAppLogAdoption(params, state, error);
    throw error;
  }
}

function adoptValidatedAppLogResource(
  params: AdoptStartedSessionAppLogParams,
  state: AppLogAdoptionState,
): void {
  const startingEnvelope = Object.freeze({
    ...validateStartedEnvelope(params),
    lifecycle: 'starting' as const,
  });
  writeAppLogResourceRecord(params.resourcePath, startingEnvelope);
  state.persisted = true;
  params.throwIfCanceled();
  const envelope = Object.freeze({ ...startingEnvelope, lifecycle: 'active' as const });
  writeAppLogResourceRecord(params.resourcePath, envelope);
  state.transferredHandle = params.pendingHandle.transfer();
  params.sessionStore.set(params.sessionName, {
    ...params.session,
    appLog: { handle: state.transferredHandle, envelope },
    appLogFailure: undefined,
  });
}

async function recoverFailedAppLogAdoption(
  params: AdoptStartedSessionAppLogParams,
  state: AppLogAdoptionState,
  primaryError: unknown,
): Promise<void> {
  if (!state.persisted) state.persisted = persistIncoherentRuntimeEnvelope(params);
  let cleanupError = await disposeFailedAppLogAdoption(params.pendingHandle, state);
  const transition = confirmFailedAdoptionTransition(params, state.persisted, cleanupError);
  cleanupError = transition.cleanupError;
  updateUndurableCleanupBlock(params.device, state.persisted, cleanupError, transition.confirmed);
  emitFailedAdoptionCleanupDiagnostic(params.sessionName, primaryError, cleanupError);
}

async function disposeFailedAppLogAdoption(
  pendingHandle: PendingTransferGuard<AppLogLiveHandle>,
  state: AppLogAdoptionState,
): Promise<unknown | undefined> {
  try {
    if (state.transferredHandle) await state.transferredHandle[Symbol.asyncDispose]();
    else await pendingHandle[Symbol.asyncDispose]();
    return undefined;
  } catch (error) {
    return error;
  }
}

function confirmFailedAdoptionTransition(
  params: Pick<AdoptStartedSessionAppLogParams, 'resourcePath' | 'fence' | 'sessionName'>,
  persisted: boolean,
  cleanupError: unknown | undefined,
): { confirmed: boolean; cleanupError: unknown | undefined } {
  if (!persisted) return { confirmed: false, cleanupError };
  try {
    return {
      confirmed: markCleanupAfterFailedAdoption(
        params.resourcePath,
        params.fence,
        cleanupError === undefined,
      ),
      cleanupError,
    };
  } catch (transitionError) {
    emitDiagnostic({
      level: 'error',
      phase: 'app_log_pending_adoption_transition_failed',
      data: {
        session: params.sessionName,
        transitionError:
          transitionError instanceof Error ? transitionError.message : String(transitionError),
      },
    });
    return { confirmed: false, cleanupError: cleanupError ?? transitionError };
  }
}

function updateUndurableCleanupBlock(
  device: DeviceInfo,
  persisted: boolean,
  cleanupError: unknown | undefined,
  transitionConfirmed: boolean,
): void {
  if ((!persisted && cleanupError === undefined) || transitionConfirmed) {
    clearUndurableAppLogCleanup(device);
    return;
  }
  blockUndurableAppLogCleanup(
    device,
    cleanupError instanceof Error
      ? cleanupError.message
      : 'The durable cleanup transition could not be confirmed',
  );
}

function emitFailedAdoptionCleanupDiagnostic(
  sessionName: string,
  primaryError: unknown,
  cleanupError: unknown | undefined,
): void {
  if (cleanupError === undefined) return;
  emitDiagnostic({
    level: 'error',
    phase: 'app_log_pending_adoption_cleanup_failed',
    data: {
      session: sessionName,
      primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
      cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    },
  });
}

function persistIncoherentRuntimeEnvelope(params: {
  sessionName: string;
  resourcePath: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  envelope: DurableResourceEnvelope<'app-log'>;
}): boolean {
  try {
    const envelope = createExpectedRecoveryEnvelope(params, params.envelope.descriptor);
    writeAppLogResourceRecord(params.resourcePath, envelope);
    return true;
  } catch (descriptorError) {
    try {
      const envelope = createExpectedRecoveryEnvelope(params, {
        version: 0,
        body: { reason: 'runtime-contract-invalid' },
      });
      writeAppLogResourceRecord(params.resourcePath, envelope);
      return true;
    } catch (persistenceError) {
      emitDiagnostic({
        level: 'error',
        phase: 'app_log_runtime_contract_tombstone_failed',
        data: {
          session: params.sessionName,
          descriptorError:
            descriptorError instanceof Error ? descriptorError.message : String(descriptorError),
          persistenceError:
            persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
        },
      });
      return false;
    }
  }
}

function createExpectedRecoveryEnvelope(
  params: {
    sessionName: string;
    device: DeviceInfo;
    owner: RuntimeOwnerRef;
    fence: ResourceOwnershipFence;
  },
  descriptor: DurableResourceEnvelope<'app-log'>['descriptor'],
): DurableResourceEnvelope<'app-log'> {
  return createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: params.sessionName,
    device: {
      id: params.device.id,
      family: params.device.platform,
      ...(params.device.appleOs === undefined ? {} : { appleOs: params.device.appleOs }),
      kind: params.device.kind,
      ...(params.device.target === undefined ? {} : { target: params.device.target }),
      ...(params.device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: params.device.iosPhysicalDeviceBackend }),
    },
    owner: params.owner,
    fence: params.fence,
    lifecycle: 'starting',
    descriptor,
    metadata: { runtimeContractInvalid: true },
  });
}

export function recordSessionAppLogFailure(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  error: unknown;
  backend?: LogBackend;
}): ReturnType<typeof normalizeError> {
  const normalized = normalizeError(params.error);
  params.sessionStore.set(params.sessionName, {
    ...params.session,
    appLog: undefined,
    appLogFailure: {
      backend: params.backend,
      code: normalized.code,
      message: normalized.message,
      hint: normalized.hint,
    },
  });
  return normalized;
}

export function clearSessionAppLogFailure(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): void {
  params.sessionStore.set(params.sessionName, {
    ...params.session,
    appLogFailure: undefined,
  });
}

export async function finishSessionAppLog(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  resourcePath: string;
}): Promise<AppLogCompletion> {
  const resource = params.session.appLog;
  if (!resource) {
    throw new AppError('INVALID_ARGS', 'no app log stream active');
  }
  const outcome = await withAppLogResourceFence({
    resourcePath: params.resourcePath,
    expected: resource.envelope.fence,
    run: async (lease) => {
      lease.transition('completing');
      const result = await resource.handle.finish();
      if (result.status === 'completed') {
        lease.transition('completed', {
          metadata: {
            ...(lease.envelope.metadata ?? {}),
            backend: result.result.backend,
            outputPath: result.result.outputPath,
            completedAt: result.result.completedAt,
          },
        });
      } else {
        lease.transition('cleanup-pending', {
          metadata: {
            ...(lease.envelope.metadata ?? {}),
            cleanupPendingReason: result.reason,
            ...(result.message ? { cleanupPendingMessage: result.message } : {}),
          },
        });
      }
      return result;
    },
  });
  if (outcome.status === 'cleanup-pending') throw cleanupPendingError(outcome);
  params.sessionStore.set(params.sessionName, {
    ...params.session,
    appLog: undefined,
    appLogFailure: undefined,
  });
  return outcome.result;
}

/** Generic close/teardown cleanup; it never re-selects a platform implementation. */
export async function forceCleanupSessionAppLog(params: {
  session: SessionState;
  sessionName?: string;
  sessionStore?: SessionStore;
  resourcePath: string;
}): Promise<void> {
  const resource = params.session.appLog;
  if (!resource) return;
  const outcome = await withAppLogResourceFence({
    resourcePath: params.resourcePath,
    expected: resource.envelope.fence,
    run: async (lease) => {
      lease.transition('completing');
      const result = await resource.handle.forceCleanup();
      lease.transition(isConfirmedCleanup(result) ? 'completed' : 'cleanup-pending', {
        metadata: {
          ...(lease.envelope.metadata ?? {}),
          cleanupStatus: result.status,
          ...(result.status === 'cleanup-pending'
            ? {
                cleanupPendingReason: result.reason,
                ...(result.message ? { cleanupPendingMessage: result.message } : {}),
              }
            : {}),
        },
      });
      return result;
    },
  });
  if (!isConfirmedCleanup(outcome)) throw cleanupPendingError(outcome);
  if (params.sessionStore && params.sessionName) {
    params.sessionStore.set(params.sessionName, {
      ...params.session,
      appLog: undefined,
      appLogFailure: undefined,
    });
  }
}

function validateStartedEnvelope(params: {
  sessionName: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  envelope: DurableResourceEnvelope<'app-log'>;
}): DurableResourceEnvelope<'app-log'> {
  const decoded = decodeDurableResourceEnvelope(params.envelope);
  if (decoded.status !== 'decoded' || decoded.envelope.resourceKind !== 'app-log') {
    throw invalidStartedEnvelope();
  }
  const { envelope } = decoded;
  if (!matchesStartedEnvelopeAuthority(envelope, params)) throw invalidStartedEnvelope();
  return createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: envelope.sessionId,
    device: envelope.device,
    owner: envelope.owner,
    fence: envelope.fence,
    lifecycle: envelope.lifecycle,
    descriptor: envelope.descriptor,
    ...(envelope.metadata === undefined ? {} : { metadata: envelope.metadata }),
  });
}

function matchesStartedEnvelopeAuthority(
  envelope: DurableResourceEnvelope,
  expected: Pick<AdoptStartedSessionAppLogParams, 'sessionName' | 'device' | 'owner' | 'fence'>,
): boolean {
  return (
    envelope.sessionId === expected.sessionName &&
    sameDurableDeviceIdentity(envelope.device, expected.device) &&
    runtimeOwnerKey(envelope.owner) === runtimeOwnerKey(expected.owner) &&
    envelope.fence.token === expected.fence.token &&
    envelope.fence.generation === expected.fence.generation &&
    isStartedLifecycle(envelope.lifecycle)
  );
}

function isStartedLifecycle(lifecycle: DurableResourceEnvelope['lifecycle']): boolean {
  return lifecycle === 'starting' || lifecycle === 'active';
}

function sameDurableDeviceIdentity(
  durable: DurableResourceEnvelope<'app-log'>['device'],
  selected: DeviceInfo,
): boolean {
  return (
    durable.id === selected.id &&
    durable.family === selected.platform &&
    durable.appleOs === selected.appleOs &&
    durable.kind === selected.kind &&
    durable.target === selected.target &&
    durable.iosPhysicalDeviceBackend === selected.iosPhysicalDeviceBackend
  );
}

function invalidStartedEnvelope(): AppError {
  return new AppError('COMMAND_FAILED', 'App-log runtime returned an incoherent durable envelope', {
    reason: 'runtime-contract-invalid',
    hint: 'Retain the runtime diagnostics and report the selected device and owner.',
  });
}

function markCleanupAfterFailedAdoption(
  resourcePath: string,
  expected: ResourceOwnershipFence,
  confirmed: boolean,
): boolean {
  const record = readAppLogResourceRecord(resourcePath);
  if (
    record.status !== 'decoded' ||
    record.envelope.fence.token !== expected.token ||
    record.envelope.fence.generation !== expected.generation
  ) {
    return false;
  }
  writeAppLogResourceRecord(resourcePath, {
    ...record.envelope,
    lifecycle: confirmed ? 'completed' : 'cleanup-pending',
    metadata: {
      ...(record.envelope.metadata ?? {}),
      cleanupStatus: confirmed ? 'cleaned' : 'cleanup-pending',
    },
  });
  return true;
}

function cleanupPendingError(
  outcome:
    | Extract<CleanupOutcome, { status: 'cleanup-pending' }>
    | {
        status: 'cleanup-pending';
        reason: string;
        message?: string;
      },
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    outcome.message ?? 'App-log cleanup could not be confirmed',
    {
      reason: outcome.reason,
      retriable: outcome.reason !== 'ownership-fence-lost',
      hint: 'Keep app-log.resource.json and retry cleanup through its exact runtime owner.',
    },
  );
}
