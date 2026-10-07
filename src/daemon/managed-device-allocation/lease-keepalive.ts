import { Deadline } from '@agent-device/host-kit/retry';
import { normalizeError } from '@agent-device/kernel/errors';
import type { ManagedLeaseAdmission, ManagedLeaseAdmissionFailure } from './lease-admission.ts';

export type ManagedLeaseLoss = Extract<
  ManagedLeaseAdmissionFailure,
  { status: 'teardown-required' }
>;

/**
 * Keeps one binding's allocator lease covering the next interval plus canonical teardown while
 * no command is running (ADR 0021 §7). Each tick runs an empty task through the binding's own
 * admission, so renewal coalescing, lookup after a lost response, and fencing stay in one place.
 */
export function startManagedLeaseKeepalive(params: {
  admission: ManagedLeaseAdmission;
  intervalMs: number;
  teardownTimeoutMs: number;
  onLost: (loss: ManagedLeaseLoss) => void;
}): Disposable {
  const stopped = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    timer = undefined;
    let loss: ManagedLeaseLoss | undefined;
    try {
      const result = await params.admission.run(
        {
          deadline: Deadline.fromTimeoutMs(params.intervalMs),
          teardownTimeoutMs: params.teardownTimeoutMs,
        },
        stopped.signal,
        async () => {},
      );
      if (result.status === 'teardown-required') loss = result;
    } catch (error) {
      loss = {
        status: 'teardown-required',
        reason: 'authority-unconfirmed',
        error: normalizeError(error),
      };
    }
    if (stopped.signal.aborted) return;
    if (loss) {
      params.onLost(loss);
      return;
    }
    // A renewal still in flight past one interval is re-awaited by the next tick rather than
    // treated as lost: the admission fences on its own once the allocator answers or fails.
    timer = setTimeout(() => void tick(), params.intervalMs);
  };

  void tick();
  return {
    [Symbol.dispose]: () => {
      stopped.abort();
      if (timer) clearTimeout(timer);
    },
  };
}
