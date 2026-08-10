import {
  isConfirmedCleanup,
  type CleanupOutcome,
  type FinishOutcome,
  type LiveResourceHandle,
} from '@agent-device/contracts/platform';
import { AppError } from '@agent-device/kernel/errors';
import {
  withDurableCaptureResourceFence,
  type DurableCaptureResourceFenceLease,
} from './durable-capture-resource-fence.ts';
import type { DurableCaptureResourceDefinition } from './durable-capture-resource.ts';
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
  const outcome = await withDurableCaptureResourceFence({
    store: definition.store,
    resourcePath,
    expected: active.envelope.fence,
    run: async (lease) => {
      markCompleting(lease);
      const result = await active.handle.finish();
      transitionFinishOutcome(definition, lease, result);
      return result;
    },
  });
  if (outcome.status === 'cleanup-pending') throw cleanupPendingError(definition, outcome);
  params.sessionStore.set(
    params.sessionName,
    definition.sessionSlot.replace(params.session, undefined),
  );
  return outcome.result;
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
  if (!isConfirmedCleanup(outcome)) throw cleanupPendingError(definition, outcome);
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

function cleanupPendingError(
  definition: Pick<
    DurableCaptureResourceDefinition<string, LiveResourceHandle<unknown>, unknown>,
    'displayName' | 'messages'
  >,
  outcome: Extract<CleanupOutcome, { status: 'cleanup-pending' }>,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    outcome.message ?? `${capitalize(definition.displayName)} cleanup could not be confirmed`,
    {
      reason: outcome.reason,
      retriable: outcome.reason !== 'ownership-fence-lost',
      hint: definition.messages.cleanupPendingHint,
    },
  );
}

function transitionFinishOutcome<K extends string, H extends LiveResourceHandle<C>, C>(
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

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
