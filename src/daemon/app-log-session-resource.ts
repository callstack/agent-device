import type { LogBackend } from '@agent-device/contracts/observability';
import {
  createDurableResourceEnvelope,
  decodeDurableResourceEnvelope,
} from '@agent-device/capture-kit';
import {
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
import { deviceIdentity, sameDeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { AppLogAdmissionLedger } from './app-log-admission-ledger.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';
import {
  withAppLogResourceFence,
  type AppLogResourceFenceLease,
} from './app-log-resource-fence.ts';
import { readAppLogResourceRecord, writeAppLogResourceRecord } from './app-log-resource-store.ts';

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
  admissionLedger: AppLogAdmissionLedger;
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

type AppLogAdoptionState =
  | { kind: 'pending' }
  | { kind: 'persisted' }
  | { kind: 'transferred'; handle: AppLogLiveHandle };

export async function adoptStartedSessionAppLog(
  params: AdoptStartedSessionAppLogParams,
): Promise<void> {
  let state: AppLogAdoptionState = { kind: 'pending' };
  try {
    const envelope = withAppLogPhase(validateStartedEnvelope(params), 'active');
    writeAppLogResourceRecord(params.resourcePath, envelope);
    state = { kind: 'persisted' };
    params.throwIfCanceled();
    const handle = params.pendingHandle.transfer();
    state = { kind: 'transferred', handle };
    params.sessionStore.set(params.sessionName, {
      ...params.session,
      appLog: { handle, envelope },
      appLogFailure: undefined,
    });
  } catch (error) {
    await recoverFailedAppLogAdoption(params, state, error);
    throw error;
  }
}

async function recoverFailedAppLogAdoption(
  params: AdoptStartedSessionAppLogParams,
  state: AppLogAdoptionState,
  primaryError: unknown,
): Promise<void> {
  const persisted = state.kind === 'pending' ? persistIncoherentRuntimeEnvelope(params) : true;
  let cleanupError = await disposeFailedAppLogAdoption(params.pendingHandle, state);
  const transition = confirmFailedAdoptionTransition(params, persisted, cleanupError);
  cleanupError = transition.cleanupError;
  updateUndurableCleanupBlock(
    params.admissionLedger,
    params.device,
    persisted,
    cleanupError,
    transition.confirmed,
  );
  emitFailedAdoptionCleanupDiagnostic(params.sessionName, primaryError, cleanupError);
}

async function disposeFailedAppLogAdoption(
  pendingHandle: PendingTransferGuard<AppLogLiveHandle>,
  state: AppLogAdoptionState,
): Promise<unknown | undefined> {
  try {
    if (state.kind === 'transferred') await state.handle[Symbol.asyncDispose]();
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
  ledger: AppLogAdmissionLedger,
  device: DeviceInfo,
  persisted: boolean,
  cleanupError: unknown | undefined,
  transitionConfirmed: boolean,
): void {
  if ((!persisted && cleanupError === undefined) || transitionConfirmed) {
    ledger.clearUndurableCleanup(device);
    return;
  }
  ledger.blockUndurableCleanup(
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
    device: deviceIdentity(params.device),
    owner: params.owner,
    fence: params.fence,
    lifecycle: 'open',
    descriptor,
    metadata: { phase: 'runtime-contract-invalid', runtimeContractInvalid: true },
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
      markAppLogResourceCompleting(lease);
      const result = await resource.handle.finish();
      if (result.status === 'completed') {
        lease.transition('completed', {
          metadata: {
            ...(lease.envelope.metadata ?? {}),
            backend: result.result.backend,
            outputPath: result.result.outputPath,
            completedAt: result.result.completedAt,
            phase: 'completed',
          },
        });
      } else {
        lease.transition('open', {
          metadata: {
            ...(lease.envelope.metadata ?? {}),
            phase: 'cleanup-pending',
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
      markAppLogResourceCompleting(lease);
      const result = await resource.handle.forceCleanup();
      lease.transition(isConfirmedCleanup(result) ? 'completed' : 'open', {
        metadata: {
          ...(lease.envelope.metadata ?? {}),
          phase: isConfirmedCleanup(result) ? 'completed' : 'cleanup-pending',
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

function markAppLogResourceCompleting(lease: AppLogResourceFenceLease): void {
  lease.transition('open', {
    metadata: { ...(lease.envelope.metadata ?? {}), phase: 'completing' },
  });
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
    sameDeviceIdentity(envelope.device, deviceIdentity(expected.device)) &&
    runtimeOwnerKey(envelope.owner) === runtimeOwnerKey(expected.owner) &&
    envelope.fence.token === expected.fence.token &&
    envelope.fence.generation === expected.fence.generation &&
    isStartedLifecycle(envelope.lifecycle)
  );
}

function isStartedLifecycle(lifecycle: DurableResourceEnvelope['lifecycle']): boolean {
  return lifecycle === 'open';
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
    lifecycle: confirmed ? 'completed' : 'open',
    metadata: {
      ...(record.envelope.metadata ?? {}),
      phase: confirmed ? 'completed' : 'cleanup-pending',
      cleanupStatus: confirmed ? 'cleaned' : 'cleanup-pending',
    },
  });
  return true;
}

function withAppLogPhase(
  envelope: DurableResourceEnvelope<'app-log'>,
  phase: string,
): DurableResourceEnvelope<'app-log'> {
  return Object.freeze({
    ...envelope,
    lifecycle: 'open',
    metadata: { ...(envelope.metadata ?? {}), phase },
  });
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
