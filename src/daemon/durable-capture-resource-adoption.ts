import type { LiveResourceHandle } from '@agent-device/contracts/durable-resource';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
  runtimeOwnerKey,
} from '@agent-device/contracts/platform-runtime';
import {
  createDurableResourceEnvelope,
  decodeDurableResourceEnvelope,
} from '@agent-device/capture-kit';
import { deviceIdentity, sameDeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type {
  AdoptStartedDurableCaptureParams,
  DurableCaptureResourceDefinition,
} from './durable-capture-resource.ts';
import {
  capitalizeDurableCaptureLabel,
  durableCaptureDiagnosticPrefix,
} from './durable-capture-resource-labels.ts';

type AdoptionState<H extends AsyncDisposable> =
  | { kind: 'pending' }
  | { kind: 'persisted' }
  | { kind: 'transferred'; handle: H };

export async function adoptStartedDurableCapture<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: AdoptStartedDurableCaptureParams<K, H>,
  resourcePath: string,
): Promise<void> {
  let state: AdoptionState<H> = { kind: 'pending' };
  try {
    const envelope = withPhase(validateStartedEnvelope(definition, params), 'active');
    definition.store.write(resourcePath, envelope);
    state = { kind: 'persisted' };
    params.throwIfCanceled();
    const handle = params.pendingHandle.transfer();
    state = { kind: 'transferred', handle };
    params.sessionStore.set(
      params.sessionName,
      definition.sessionSlot.replace(params.session, { handle, envelope }),
    );
  } catch (error) {
    await recoverFailedAdoption(definition, params, resourcePath, state, error);
    throw error;
  }
}

async function recoverFailedAdoption<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: AdoptStartedDurableCaptureParams<K, H>,
  resourcePath: string,
  state: AdoptionState<H>,
  primaryError: unknown,
): Promise<void> {
  const persisted =
    state.kind === 'pending' ? persistRecoveryTombstone(definition, params, resourcePath) : true;
  const initialCleanupError = await disposeFailedAdoption(params, state);
  const transition = confirmFailedAdoptionTransition(
    definition,
    params,
    resourcePath,
    initialCleanupError,
  );
  if ((!persisted && transition.cleanupError === undefined) || transition.confirmed) {
    params.admissionLedger.clearUndurableCleanup(params.device);
  } else {
    params.admissionLedger.blockUndurableCleanup(
      params.device,
      transition.cleanupError instanceof Error
        ? transition.cleanupError.message
        : 'The durable cleanup transition could not be confirmed',
    );
  }
  if (transition.cleanupError !== undefined)
    emitCleanupDiagnostic(definition, params, primaryError, transition.cleanupError);
}

function confirmFailedAdoptionTransition<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: Pick<AdoptStartedDurableCaptureParams<K, H>, 'sessionName' | 'fence'>,
  resourcePath: string,
  cleanupError: unknown | undefined,
): { confirmed: boolean; cleanupError: unknown | undefined } {
  try {
    return {
      confirmed: confirmFailedAdoption(definition, resourcePath, params.fence, cleanupError),
      cleanupError,
    };
  } catch (transitionError) {
    emitDiagnostic({
      level: 'error',
      phase: `${durableCaptureDiagnosticPrefix(definition.resourceKind)}_pending_adoption_transition_failed`,
      data: {
        session: params.sessionName,
        transitionError:
          transitionError instanceof Error ? transitionError.message : String(transitionError),
      },
    });
    return { confirmed: false, cleanupError: cleanupError ?? transitionError };
  }
}

async function disposeFailedAdoption<K extends string, H extends AsyncDisposable>(
  params: AdoptStartedDurableCaptureParams<K, H>,
  state: AdoptionState<H>,
): Promise<unknown | undefined> {
  try {
    if (state.kind === 'transferred') await state.handle[Symbol.asyncDispose]();
    else await params.pendingHandle[Symbol.asyncDispose]();
    return undefined;
  } catch (error) {
    return error;
  }
}

function persistRecoveryTombstone<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: AdoptStartedDurableCaptureParams<K, H>,
  resourcePath: string,
): boolean {
  try {
    definition.store.write(
      resourcePath,
      createExpectedEnvelope(definition, params, params.envelope.descriptor),
    );
    return true;
  } catch (descriptorError) {
    try {
      definition.store.write(
        resourcePath,
        createExpectedEnvelope(definition, params, {
          version: 0,
          body: { reason: 'runtime-contract-invalid' },
        }),
      );
      return true;
    } catch (persistenceError) {
      emitDiagnostic({
        level: 'error',
        phase: `${durableCaptureDiagnosticPrefix(definition.resourceKind)}_runtime_contract_tombstone_failed`,
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

function createExpectedEnvelope<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: Pick<
    AdoptStartedDurableCaptureParams<K, H>,
    'sessionName' | 'device' | 'owner' | 'fence'
  >,
  descriptor: DurableResourceEnvelope<K>['descriptor'],
): DurableResourceEnvelope<K> {
  return createDurableResourceEnvelope({
    resourceKind: definition.resourceKind,
    sessionId: params.sessionName,
    device: deviceIdentity(params.device),
    owner: params.owner,
    fence: params.fence,
    lifecycle: 'open',
    descriptor,
    metadata: { phase: 'runtime-contract-invalid', runtimeContractInvalid: true },
  });
}

function validateStartedEnvelope<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: Pick<
    AdoptStartedDurableCaptureParams<K, H>,
    'sessionName' | 'device' | 'owner' | 'fence' | 'envelope'
  >,
): DurableResourceEnvelope<K> {
  const decoded = decodeDurableResourceEnvelope(params.envelope);
  if (
    decoded.status === 'decoded' &&
    matchesAuthority(decoded.envelope, params, definition.resourceKind)
  ) {
    return decoded.envelope as DurableResourceEnvelope<K>;
  }
  throw new AppError(
    'COMMAND_FAILED',
    `${capitalizeDurableCaptureLabel(definition.displayName)} runtime returned an incoherent durable envelope`,
    {
      reason: 'runtime-contract-invalid',
      hint: 'Retain the runtime diagnostics and report the selected device and owner.',
    },
  );
}

function matchesAuthority(
  envelope: DurableResourceEnvelope,
  expected: {
    sessionName: string;
    device: DeviceInfo;
    owner: RuntimeOwnerRef;
    fence: ResourceOwnershipFence;
  },
  resourceKind: string,
): boolean {
  return (
    envelope.resourceKind === resourceKind &&
    envelope.sessionId === expected.sessionName &&
    sameDeviceIdentity(envelope.device, deviceIdentity(expected.device)) &&
    runtimeOwnerKey(envelope.owner) === runtimeOwnerKey(expected.owner) &&
    envelope.fence.token === expected.fence.token &&
    envelope.fence.generation === expected.fence.generation &&
    envelope.lifecycle === 'open'
  );
}

function confirmFailedAdoption<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  resourcePath: string,
  expected: ResourceOwnershipFence,
  cleanupError: unknown | undefined,
): boolean {
  const record = definition.store.read(resourcePath);
  if (
    record.status !== 'decoded' ||
    record.envelope.fence.token !== expected.token ||
    record.envelope.fence.generation !== expected.generation
  )
    return false;
  definition.store.write(resourcePath, {
    ...record.envelope,
    lifecycle: cleanupError === undefined ? 'completed' : 'open',
    metadata: {
      ...(record.envelope.metadata ?? {}),
      phase: cleanupError === undefined ? 'completed' : 'cleanup-pending',
      cleanupStatus: cleanupError === undefined ? 'cleaned' : 'cleanup-pending',
    },
  });
  return true;
}

function emitCleanupDiagnostic<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: Pick<AdoptStartedDurableCaptureParams<K, H>, 'sessionName'>,
  primaryError: unknown,
  cleanupError: unknown,
): void {
  emitDiagnostic({
    level: 'error',
    phase: `${durableCaptureDiagnosticPrefix(definition.resourceKind)}_pending_adoption_cleanup_failed`,
    data: {
      session: params.sessionName,
      primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
      cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    },
  });
}

function withPhase<K extends string>(
  envelope: DurableResourceEnvelope<K>,
  phase: string,
): DurableResourceEnvelope<K> {
  return Object.freeze({
    ...envelope,
    lifecycle: 'open',
    metadata: { ...(envelope.metadata ?? {}), phase },
  });
}
