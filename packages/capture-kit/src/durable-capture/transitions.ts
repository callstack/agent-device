import {
  type CleanupOutcome,
  type DurableCaptureProgress,
  type FinishOutcome,
  type LiveResourceHandle,
  isConfirmedCleanup,
} from '@agent-device/contracts/durable-resource';
import type { JsonObject } from '@agent-device/contracts/client';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  completedDurableCaptureError,
  withDurableCaptureResourceFence,
  type DurableCaptureOpenResourceFenceLease,
} from './fence.ts';
import type {
  DurableCaptureFinishIntent,
  DurableCaptureRecordDefinition,
  DurableCaptureSessionBinding,
} from './definition.ts';
import { capitalizeDurableCaptureLabel, durableCaptureDiagnosticPrefix } from './labels.ts';

export async function finishLiveDurableCapture<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureRecordDefinition<K, C>,
  params: {
    binding: DurableCaptureSessionBinding<K, H>;
    intent: DurableCaptureFinishIntent;
  },
  resourcePath: string,
): Promise<C> {
  const active = params.binding.read();
  if (!active) throw new AppError('INVALID_ARGS', definition.messages.noActive);
  let cleanupPending = false;
  try {
    const result = await finishDurableCaptureHandle(definition, {
      handle: active.handle,
      fence: active.envelope.fence,
      resourcePath,
      intent: params.intent,
      onCleanupPending: () => {
        cleanupPending = true;
      },
    });
    if (!cleanupPending) params.binding.clear(active);
    return result;
  } catch (error) {
    const record = definition.store.read(resourcePath);
    if (
      !cleanupPending &&
      record.status === 'decoded' &&
      record.envelope.lifecycle === 'completed'
    ) {
      params.binding.clear(active);
    }
    throw error;
  }
}

export async function finishDurableCaptureHandle<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureRecordDefinition<K, C>,
  params: {
    handle: H;
    fence: ResourceOwnershipFence;
    resourcePath: string;
    intent: DurableCaptureFinishIntent;
    onCleanupPending?(outcome: Extract<CleanupOutcome, { status: 'cleanup-pending' }>): void;
  },
): Promise<C> {
  return await withDurableCaptureResourceFence({
    store: definition.store,
    resourcePath: params.resourcePath,
    expected: params.fence,
    // The record this fence found committed already holds an outcome. A finish arriving after that is
    // not a failure to report: it is a caller that needs what the first finish produced, and the record
    // is the only place it can come from. A queued teardown finish that had to be refused this way
    // reported the session's export as an unreleased resource.
    onCompleted: async ({ envelope }) => {
      let cleanup: CleanupOutcome;
      try {
        cleanup = await params.handle.forceCleanup();
      } catch (error) {
        cleanup = {
          status: 'cleanup-pending',
          reason: 'cleanup-unconfirmed',
          message: errorMessage(error),
        };
      }
      if (!isConfirmedCleanup(cleanup)) {
        params.onCleanupPending?.(cleanup);
        emitDiagnostic({
          level: 'warn',
          phase: `${durableCaptureDiagnosticPrefix(definition.resourceKind)}_terminal_cleanup_pending`,
          data: { resourcePath: params.resourcePath, cleanup },
        });
        if (params.intent === 'disposal') throw cleanupPendingError(definition, cleanup);
      }
      const replayed = await definition.completionFromMetadata?.(envelope.metadata);
      if (replayed !== undefined) return replayed;
      if (!isConfirmedCleanup(cleanup)) throw cleanupPendingError(definition, cleanup);
      throw completedDurableCaptureError(definition.store);
    },
    run: async (lease) => {
      markCompletingDurableCapture(lease);
      const progress = createStopProgress(lease);
      let finishOutcome: FinishOutcome<C>;
      try {
        finishOutcome = await params.handle.finish(progress);
      } catch (finishError) {
        await respondToFailedFinish(definition, lease, params, finishError, params.intent);
        throw finishError;
      }
      if (finishOutcome.status === 'completed') {
        transitionFinishOutcome(definition, lease, finishOutcome);
        if (finishOutcome.cleanupPending) {
          params.onCleanupPending?.(finishOutcome.cleanupPending);
          if (params.intent === 'disposal')
            throw cleanupPendingError(definition, finishOutcome.cleanupPending);
        }
        return finishOutcome.result;
      }
      transitionFinishOutcome(definition, lease, finishOutcome);
      const finishError = cleanupPendingError(definition, finishOutcome);
      await respondToFailedFinish(definition, lease, params, finishError, params.intent);
      throw finishError;
    },
  });
}

async function respondToFailedFinish<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureRecordDefinition<K, C>,
  lease: DurableCaptureOpenResourceFenceLease<K>,
  params: { handle: H; resourcePath: string },
  finishError: unknown,
  intent: DurableCaptureFinishIntent,
): Promise<void> {
  if (intent === 'capture' && definition.failedFinishPolicy === 'preserve-retry-material') {
    emitFailedFinishPreservedDiagnostic(definition, params, finishError);
    return;
  }
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
  lease: DurableCaptureOpenResourceFenceLease<K>,
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

function emitFailedFinishPreservedDiagnostic<K extends string, C>(
  definition: DurableCaptureRecordDefinition<K, C>,
  params: { resourcePath: string },
  finishError: unknown,
): void {
  emitDiagnostic({
    level: 'error',
    phase: `${durableCaptureDiagnosticPrefix(definition.resourceKind)}_finish_evidence_preserved`,
    data: {
      resourcePath: params.resourcePath,
      finishError: errorMessage(finishError),
      failedFinishPolicy: definition.failedFinishPolicy,
    },
  });
}

function emitFailedFinishCleanupDiagnostic<K extends string, C>(
  definition: DurableCaptureRecordDefinition<K, C>,
  params: { resourcePath: string },
  finishError: unknown,
  cleanupError: unknown,
  transitionError?: unknown,
): void {
  emitDiagnostic({
    level: 'error',
    phase: `${durableCaptureDiagnosticPrefix(definition.resourceKind)}_finish_cleanup_failed`,
    data: {
      resourcePath: params.resourcePath,
      finishError: errorMessage(finishError),
      cleanupError:
        cleanupError === undefined ? 'cleanup could not be confirmed' : errorMessage(cleanupError),
      ...(transitionError === undefined ? {} : { transitionError: errorMessage(transitionError) }),
    },
  });
}

export async function forceCleanupLiveDurableCapture<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureRecordDefinition<K, C>,
  params: {
    binding: DurableCaptureSessionBinding<K, H>;
    resourcePath: string;
  },
): Promise<void> {
  const active = params.binding.read();
  if (!active) return;
  const outcome = await withDurableCaptureResourceFence({
    store: definition.store,
    resourcePath: params.resourcePath,
    expected: active.envelope.fence,
    // The record is settled, but the handle this caller captured is still a native resource of its
    // own: a commit through another entry point (recovery, or a finish this caller never saw) leaves
    // it live here. Signal it and report what it answers, without letting it touch the record — a
    // kind whose cleanup is already done after its own commit answers confirmed.
    onCompleted: async () => await active.handle.forceCleanup(),
    run: async (lease) => {
      markCompletingDurableCapture(lease);
      const result = await active.handle.forceCleanup();
      transitionCleanupOutcome(lease, result);
      return result;
    },
  });
  requireConfirmedDurableCaptureCleanup(definition, outcome);
  params.binding.clear(active);
}

/**
 * Removes what a persisted record points at when its native resource could not be reattached, and
 * journals that removal.
 *
 * The cleanup is destructive, so it runs inside the fence's `run`, not before it: acquiring recovery
 * authority can take long enough for another caller to commit the record, and removal that arrives
 * after that commit has nothing left to remove. The terminal branch therefore answers `already-missing`
 * — what a committed record states about its own descriptor, since the commit that produced it confirmed
 * its cleanup — and removes nothing.
 */
export async function cleanupDurableCaptureDescriptor<K extends string>(
  definition: DurableCaptureRecordDefinition<K, unknown>,
  params: {
    envelope: DurableResourceEnvelope<K>;
    resourcePath: string;
    cleanup(): Promise<CleanupOutcome>;
  },
): Promise<CleanupOutcome> {
  return await withDurableCaptureResourceFence({
    store: definition.store,
    resourcePath: params.resourcePath,
    expected: params.envelope.fence,
    onCompleted: () => ({ status: 'already-missing' as const }),
    run: async (lease) => {
      const outcome = await params.cleanup();
      transitionCleanupOutcome(lease, outcome);
      return outcome;
    },
  });
}

export function transitionCleanupOutcome<K extends string>(
  lease: DurableCaptureOpenResourceFenceLease<K>,
  outcome: CleanupOutcome,
): void {
  const metadata = { ...(lease.envelope.metadata ?? {}) };
  if (isConfirmedCleanup(outcome)) {
    delete metadata.cleanupPendingReason;
    delete metadata.cleanupPendingMessage;
  }
  lease.transition(isConfirmedCleanup(outcome) ? 'completed' : 'open', {
    metadata: {
      ...metadata,
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
  definition: Pick<DurableCaptureRecordDefinition<string, unknown>, 'displayName' | 'messages'>,
  outcome: CleanupOutcome,
): void {
  if (!isConfirmedCleanup(outcome)) throw cleanupPendingError(definition, outcome);
}

function cleanupPendingError(
  definition: Pick<DurableCaptureRecordDefinition<string, unknown>, 'displayName' | 'messages'>,
  outcome: Extract<CleanupOutcome, { status: 'cleanup-pending' }>,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    outcome.message ??
      `${capitalizeDurableCaptureLabel(definition.displayName)} cleanup could not be confirmed`,
    {
      reason: outcome.reason,
      cleanupStatus: outcome.status,
      retriable: outcome.reason !== 'ownership-fence-lost',
      hint: definition.messages.cleanupPendingHint,
    },
  );
}

export function transitionFinishOutcome<K extends string, C>(
  definition: DurableCaptureRecordDefinition<K, C>,
  lease: DurableCaptureOpenResourceFenceLease<K>,
  outcome: FinishOutcome<C>,
): void {
  if (outcome.status === 'completed') {
    definition.validateCompletion?.(outcome.result);
    const metadata = { ...(lease.envelope.metadata ?? {}) };
    if (!outcome.cleanupPending) {
      delete metadata.cleanupPendingReason;
      delete metadata.cleanupPendingMessage;
    }
    lease.transition(outcome.cleanupPending ? 'open' : 'completed', {
      metadata: {
        ...metadata,
        ...definition.completionMetadata(outcome.result),
        ...(outcome.cleanupPending
          ? definition.pendingCompletionMetadata?.(outcome.result, lease.envelope)
          : {}),
        phase: outcome.cleanupPending ? 'cleanup-pending' : 'completed',
        ...(outcome.cleanupPending
          ? {
              cleanupStatus: outcome.cleanupPending.status,
              cleanupPendingReason: outcome.cleanupPending.reason,
              ...(outcome.cleanupPending.message
                ? { cleanupPendingMessage: outcome.cleanupPending.message }
                : {}),
            }
          : lease.envelope.metadata?.cleanupStatus === 'cleanup-pending'
            ? { cleanupStatus: 'cleaned' }
            : {}),
      },
    });
    return;
  }
  transitionCleanupOutcome(lease, outcome);
}

/**
 * The manifest the stop is allowed to write into while it holds this fence (ADR 0024 2.3). What a
 * kind records is its own vocabulary; the mechanics only merge each fact into the metadata and hand
 * back what is already there, so a stop that dies mid-way leaves its own facts beside the open
 * record and the next attempt reads them instead of redoing durable work.
 */
export function createStopProgress<K extends string>(
  lease: DurableCaptureOpenResourceFenceLease<K>,
): DurableCaptureProgress {
  return Object.freeze({
    learned: lease.envelope.metadata,
    record: (fact: JsonObject) => {
      lease.transition('open', { metadata: { ...(lease.envelope.metadata ?? {}), ...fact } });
    },
  });
}

/**
 * The fact that an attempt is in flight, journaled into a record this fence found open. Recovery
 * reads it to tell an abandoned attempt from one that never started, so it belongs to every entry
 * that drives a record toward completion, not to one of them.
 */
export function markCompletingDurableCapture<K extends string>(
  lease: DurableCaptureOpenResourceFenceLease<K>,
): void {
  lease.transition('open', {
    metadata: { ...(lease.envelope.metadata ?? {}), phase: 'completing' },
  });
}
