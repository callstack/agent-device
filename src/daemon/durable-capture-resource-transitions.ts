import {
  type CleanupOutcome,
  type FinishOutcome,
  type LiveResourceHandle,
  isConfirmedCleanup,
} from '@agent-device/contracts/durable-resource';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import {
  withDurableCaptureResourceFence,
  type DurableCaptureResourceFenceLease,
} from './durable-capture-resource-fence.ts';
import type { DurableCaptureResourceDefinition } from './durable-capture-resource.ts';
import { capitalizeDurableCaptureLabel } from './durable-capture-resource-labels.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

export async function finishLiveDurableCapture<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: { session: SessionState; sessionName: string; sessionStore: SessionStore },
  resourcePath: string,
): Promise<C> {
  const active = definition.sessionSlot.read(params.session);
  if (!active) throw new AppError('INVALID_ARGS', definition.messages.noActive);
  try {
    const result = await finishDurableCaptureHandle(definition, {
      handle: active.handle,
      fence: active.envelope.fence,
      resourcePath,
    });
    clearLiveSlot(definition, params);
    return result;
  } catch (error) {
    const record = definition.store.read(resourcePath);
    if (record.status === 'decoded' && record.envelope.lifecycle === 'completed') {
      clearLiveSlot(definition, params);
    }
    throw error;
  }
}

export async function finishDurableCaptureHandle<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: {
    handle: H;
    fence: DurableCaptureResourceFenceLease<K>['envelope']['fence'];
    resourcePath: string;
  },
): Promise<C> {
  return await withDurableCaptureResourceFence({
    store: definition.store,
    resourcePath: params.resourcePath,
    expected: params.fence,
    run: async (lease) => {
      markCompleting(lease);
      let finishOutcome: FinishOutcome<C>;
      try {
        finishOutcome = await params.handle.finish();
      } catch (finishError) {
        await compensateFailedFinish(definition, lease, params, finishError);
        throw finishError;
      }
      if (finishOutcome.status === 'completed') {
        transitionFinishOutcome(definition, lease, finishOutcome);
        return finishOutcome.result;
      }
      transitionFinishOutcome(definition, lease, finishOutcome);
      const finishError = cleanupPendingError(definition, finishOutcome);
      await compensateFailedFinish(definition, lease, params, finishError);
      throw finishError;
    },
  });
}

async function compensateFailedFinish<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  lease: DurableCaptureResourceFenceLease<K>,
  params: { handle: H; resourcePath: string },
  finishError: unknown,
): Promise<void> {
  let cleanup: CleanupOutcome;
  try {
    cleanup = await params.handle.forceCleanup();
  } catch (cleanupError) {
    const transitionError = persistCleanupPendingBestEffort(lease, cleanupError);
    emitFailedFinishCleanupDiagnostic(
      definition,
      params,
      finishError,
      cleanupError,
      transitionError,
    );
    return;
  }
  try {
    transitionCleanupOutcome(lease, cleanup);
  } catch (transitionError) {
    emitFailedFinishCleanupDiagnostic(
      definition,
      params,
      finishError,
      cleanup.status === 'cleanup-pending'
        ? (cleanup.message ?? cleanup.reason)
        : `cleanup returned ${cleanup.status}`,
      transitionError,
    );
    return;
  }
  if (isConfirmedCleanup(cleanup)) return;
  emitFailedFinishCleanupDiagnostic(definition, params, finishError, cleanup.message);
}

function persistCleanupPendingBestEffort<K extends string>(
  lease: DurableCaptureResourceFenceLease<K>,
  cleanupError: unknown,
): unknown | undefined {
  try {
    transitionCleanupOutcome(lease, {
      status: 'cleanup-pending',
      reason: 'cleanup-unconfirmed',
      message: errorMessage(cleanupError),
    });
    return undefined;
  } catch (transitionError) {
    return transitionError;
  }
}

function emitFailedFinishCleanupDiagnostic<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: { resourcePath: string },
  finishError: unknown,
  cleanupError: unknown,
  transitionError?: unknown,
): void {
  emitDiagnostic({
    level: 'error',
    phase: `${definition.resourceKind.replaceAll('-', '_')}_finish_cleanup_failed`,
    data: {
      resourcePath: params.resourcePath,
      finishError: errorMessage(finishError),
      cleanupError:
        cleanupError === undefined ? 'cleanup could not be confirmed' : errorMessage(cleanupError),
      ...(transitionError === undefined ? {} : { transitionError: errorMessage(transitionError) }),
    },
  });
}

function clearLiveSlot<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: { session: SessionState; sessionName: string; sessionStore: SessionStore },
): void {
  params.sessionStore.set(
    params.sessionName,
    definition.sessionSlot.replace(params.session, undefined),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function forceCleanupLiveDurableCapture<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: {
    session: SessionState;
    sessionName?: string;
    sessionStore?: SessionStore;
    resourcePath: string;
  },
): Promise<void> {
  const active = definition.sessionSlot.read(params.session);
  if (!active) return;
  const outcome = await withDurableCaptureResourceFence({
    store: definition.store,
    resourcePath: params.resourcePath,
    expected: active.envelope.fence,
    run: async (lease) => {
      markCompleting(lease);
      const result = await active.handle.forceCleanup();
      transitionCleanupOutcome(lease, result);
      return result;
    },
  });
  requireConfirmedDurableCaptureCleanup(definition, outcome);
  if (params.sessionStore && params.sessionName) {
    params.sessionStore.set(
      params.sessionName,
      definition.sessionSlot.replace(params.session, undefined),
    );
  }
}

export function transitionCleanupOutcome<K extends string>(
  lease: DurableCaptureResourceFenceLease<K>,
  outcome: CleanupOutcome,
): void {
  lease.transition(isConfirmedCleanup(outcome) ? 'completed' : 'open', {
    metadata: {
      ...(lease.envelope.metadata ?? {}),
      phase: isConfirmedCleanup(outcome) ? 'completed' : 'cleanup-pending',
      cleanupStatus: outcome.status,
      ...(outcome.status === 'cleanup-pending'
        ? {
            cleanupPendingReason: outcome.reason,
            ...(outcome.message ? { cleanupPendingMessage: outcome.message } : {}),
          }
        : {}),
    },
  });
}

export function requireConfirmedDurableCaptureCleanup(
  definition: Pick<
    DurableCaptureResourceDefinition<string, LiveResourceHandle<unknown>, unknown>,
    'displayName' | 'messages'
  >,
  outcome: CleanupOutcome,
): void {
  if (!isConfirmedCleanup(outcome)) throw cleanupPendingError(definition, outcome);
}

function cleanupPendingError(
  definition: Pick<
    DurableCaptureResourceDefinition<string, LiveResourceHandle<unknown>, unknown>,
    'displayName' | 'messages'
  >,
  outcome: Extract<CleanupOutcome, { status: 'cleanup-pending' }>,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    outcome.message ??
      `${capitalizeDurableCaptureLabel(definition.displayName)} cleanup could not be confirmed`,
    {
      reason: outcome.reason,
      retriable: outcome.reason !== 'ownership-fence-lost',
      hint: definition.messages.cleanupPendingHint,
    },
  );
}

export function transitionFinishOutcome<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  lease: DurableCaptureResourceFenceLease<K>,
  outcome: FinishOutcome<C>,
): void {
  if (outcome.status === 'completed') {
    lease.transition('completed', {
      metadata: {
        ...(lease.envelope.metadata ?? {}),
        ...definition.completionMetadata(outcome.result),
        phase: 'completed',
      },
    });
    return;
  }
  transitionCleanupOutcome(lease, outcome);
}

function markCompleting<K extends string>(lease: DurableCaptureResourceFenceLease<K>): void {
  lease.transition('open', {
    metadata: { ...(lease.envelope.metadata ?? {}), phase: 'completing' },
  });
}
