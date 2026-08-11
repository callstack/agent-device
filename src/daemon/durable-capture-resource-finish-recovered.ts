import type {
  DurableResourceEnvelope,
  LiveResourceHandle,
  PlatformRequestScope,
} from '@agent-device/contracts/platform';
import { AppError } from '@agent-device/kernel/errors';
import {
  acquireDurableCaptureRecoveryAuthorityBeforeDeadline,
  type DurableCaptureRecoveryControl,
} from './durable-capture-recovery-authority.ts';
import { allowsDurableCaptureDescriptorCleanup } from './durable-capture-resource-recovery.ts';
import { withDurableCaptureResourceFence } from './durable-capture-resource-fence.ts';
import type { DurableCaptureResourceDefinition } from './durable-capture-resource.ts';
import {
  capitalizeDurableCaptureLabel,
  durableCaptureDiagnosticPrefix,
} from './durable-capture-resource-labels.ts';
import {
  finishDurableCaptureHandle,
  requireConfirmedDurableCaptureCleanup,
  transitionCleanupOutcome,
  transitionFinishOutcome,
} from './durable-capture-resource-transitions.ts';

const DEFAULT_FINISH_RECOVERY_DEADLINE_MS = 5_000;

export type FinishRecoveredDurableCaptureParams<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
> = Readonly<{
  resourcePath: string;
  scope: PlatformRequestScope;
  acquireControl(
    envelope: DurableResourceEnvelope<K>,
    scope: PlatformRequestScope,
  ): Promise<DurableCaptureRecoveryControl<K, H, C>>;
  deadlineMs?: number;
}>;

export async function finishRecoveredDurableCapture<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: FinishRecoveredDurableCaptureParams<K, H, C>,
): Promise<C> {
  const record = definition.store.read(params.resourcePath);
  if (record.status !== 'decoded' || record.envelope.lifecycle !== 'open') {
    throw noRecoverableResource(definition, record.status);
  }
  const envelope = record.envelope;
  const authority = await acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
    displayName: definition.displayName,
    envelope,
    scope: params.scope,
    deadlineMs: params.deadlineMs ?? DEFAULT_FINISH_RECOVERY_DEADLINE_MS,
    acquireControl: params.acquireControl,
    onLateCleanupFailure: (phase, cleanupError, primaryError) =>
      params.scope.diagnostics.emit({
        level: 'error',
        phase: `${durableCaptureDiagnosticPrefix(definition.resourceKind)}_recovery_${phase}`,
        data: {
          resourcePath: params.resourcePath,
          error: errorMessage(cleanupError),
          primaryError: errorMessage(primaryError),
        },
      }),
  });
  try {
    switch (authority.reattached.status) {
      case 'active':
        return await finishDurableCaptureHandle(definition, {
          handle: authority.reattached.handle,
          fence: envelope.fence,
          resourcePath: params.resourcePath,
        });
      case 'completed': {
        const result = authority.reattached.result;
        await withDurableCaptureResourceFence({
          store: definition.store,
          resourcePath: params.resourcePath,
          expected: envelope.fence,
          run: async (lease) => {
            transitionFinishOutcome(definition, lease, {
              status: 'completed',
              result,
              alreadyCompleted: true,
            });
          },
        });
        return result;
      }
      case 'missing':
        throw new AppError(
          'COMMAND_FAILED',
          `${capitalizeDurableCaptureLabel(definition.displayName)} is missing`,
          {
            reason: 'resource-missing',
            hint: definition.messages.cleanupPendingHint,
          },
        );
      case 'unreattachable': {
        if (allowsDurableCaptureDescriptorCleanup(authority.reattached.reason)) {
          const cleanup = await authority.control.cleanup(envelope);
          await withDurableCaptureResourceFence({
            store: definition.store,
            resourcePath: params.resourcePath,
            expected: envelope.fence,
            run: async (lease) => transitionCleanupOutcome(lease, cleanup),
          });
          requireConfirmedDurableCaptureCleanup(definition, cleanup);
        }
        throw new AppError(
          'COMMAND_FAILED',
          authority.reattached.message ??
            `${capitalizeDurableCaptureLabel(definition.displayName)} cannot be reattached`,
          {
            reason: authority.reattached.reason,
            hint: definition.messages.cleanupPendingHint,
          },
        );
      }
    }
  } finally {
    await authority.control[Symbol.asyncDispose]();
  }
}

function noRecoverableResource(
  definition: DurableCaptureResourceDefinition<string, LiveResourceHandle<unknown>, unknown>,
  status: 'missing' | 'decoded' | 'unreattachable',
): AppError {
  return new AppError(
    'INVALID_ARGS',
    status === 'missing'
      ? definition.messages.noActive
      : `${capitalizeDurableCaptureLabel(definition.displayName)} recovery record is not open`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
