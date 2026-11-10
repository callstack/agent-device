import { Deadline } from '@agent-device/host-kit/retry';
import type { SimulatorAppListOptions } from './tool-provider-types.ts';

export function remainingLookupBudget({
  timeoutMs,
  signal,
}: SimulatorAppListOptions): () => SimulatorAppListOptions {
  const abortable = signal ? { signal } : {};
  if (timeoutMs === undefined) return () => abortable;
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  return () => ({ timeoutMs: Math.max(1, deadline.remainingMs()), ...abortable });
}
