import type {
  CleanupOutcome,
  LiveResourceHandle,
  ReattachOutcome,
} from '@agent-device/contracts/durable-resource';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { capitalizeDurableCaptureLabel } from './durable-capture-resource-labels.ts';

export type DurableCaptureRecoveryControl<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
> = AsyncDisposable &
  Readonly<{
    reattach(envelope: DurableResourceEnvelope<K>): Promise<ReattachOutcome<H, C>>;
    cleanup(envelope: DurableResourceEnvelope<K>): Promise<CleanupOutcome>;
  }>;

export type DurableCaptureRecoveryAuthority<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
> = Readonly<{
  control: DurableCaptureRecoveryControl<K, H, C>;
  reattached: ReattachOutcome<H, C>;
}>;

export type DurableCaptureRecoveryAuthorityParams<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
> = Readonly<{
  displayName: string;
  envelope: DurableResourceEnvelope<K>;
  scope: PlatformRequestScope;
  deadlineMs: number;
  acquireControl(
    envelope: DurableResourceEnvelope<K>,
    scope: PlatformRequestScope,
  ): Promise<DurableCaptureRecoveryControl<K, H, C>>;
  onLateCleanupFailure(phase: string, cleanupError: unknown, primaryError: unknown): void;
}>;

export async function acquireDurableCaptureRecoveryAuthorityBeforeDeadline<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(
  params: DurableCaptureRecoveryAuthorityParams<K, H, C>,
): Promise<DurableCaptureRecoveryAuthority<K, H, C>> {
  params.scope.signal.throwIfAborted();
  const controller = new AbortController();
  const scope = {
    ...params.scope,
    signal: AbortSignal.any([params.scope.signal, controller.signal]),
  };
  let rejectDeadline: (error: DurableCaptureRecoveryDeadlineError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  let stopListeningForCancellation = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => {
    const rejectCancellation = () => {
      try {
        params.scope.signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    if (params.scope.signal.aborted) {
      rejectCancellation();
      return;
    }
    params.scope.signal.addEventListener('abort', rejectCancellation, { once: true });
    stopListeningForCancellation = () =>
      params.scope.signal.removeEventListener('abort', rejectCancellation);
  });
  const timer = setTimeout(() => {
    const error = new DurableCaptureRecoveryDeadlineError(params.displayName, params.deadlineMs);
    controller.abort(error);
    rejectDeadline(error);
  }, params.deadlineMs);
  timer.unref?.();
  const acquisition = acquireRecoveryAuthority(params, scope);
  try {
    return await Promise.race([acquisition, deadline, cancellation]);
  } finally {
    clearTimeout(timer);
    stopListeningForCancellation();
    void acquisition.catch(() => {});
  }
}

async function acquireRecoveryAuthority<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryAuthorityParams<K, H, C>,
  scope: PlatformRequestScope,
): Promise<DurableCaptureRecoveryAuthority<K, H, C>> {
  let control: DurableCaptureRecoveryControl<K, H, C> | undefined;
  let reattached: ReattachOutcome<H, C> | undefined;
  try {
    control = await params.acquireControl(params.envelope, scope);
    scope.signal.throwIfAborted();
    reattached = await control.reattach(params.envelope);
    scope.signal.throwIfAborted();
    return { control, reattached };
  } catch (error) {
    if (reattached?.status === 'active') {
      await disposeLateAuthority(params, reattached.handle, 'late_handle_cleanup_failed', error);
    }
    if (control) {
      await disposeLateAuthority(params, control, 'late_control_cleanup_failed', error);
    }
    throw error;
  }
}

async function disposeLateAuthority<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryAuthorityParams<K, H, C>,
  value: AsyncDisposable,
  phase: string,
  primaryError: unknown,
): Promise<void> {
  try {
    await value[Symbol.asyncDispose]();
  } catch (cleanupError) {
    params.onLateCleanupFailure(phase, cleanupError, primaryError);
  }
}

export class DurableCaptureRecoveryDeadlineError extends Error {
  readonly deadlineMs: number;

  constructor(displayName: string, deadlineMs: number) {
    super(
      `${capitalizeDurableCaptureLabel(displayName)} recovery exceeded its ${deadlineMs}ms deadline`,
    );
    this.name = 'DurableCaptureRecoveryDeadlineError';
    this.deadlineMs = deadlineMs;
  }
}
