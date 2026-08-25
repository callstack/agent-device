import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one app-event delivery. `eventUrl` arrives already resolved: the event name,
 * its payload, and the per-platform URL template are the daemon's policy (env-configured
 * templates, size limits, name validation), and none of that is device mechanics. What reaches
 * the owner is a URL to open on the device.
 */
export type AppEventInput = Readonly<{
  eventUrl: string;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * Delivery returns nothing. The retired leaf discarded whatever the interactor answered and
 * reported only the event name and URL it sent, so a result type here would be a surface the
 * command never had.
 */
export type AppEventRuntimeOperations = Readonly<{
  triggerAppEvent(input: AppEventInput): Promise<void>;
}>;

export type AppEventRuntimeOperationFacts = Readonly<{
  triggerAppEvent: RuntimeOperationFact;
}>;

export function appEventRuntimeOperationFacts(
  input: Readonly<{ triggerAppEvent: RuntimeOperationFact }>,
): AppEventRuntimeOperationFacts {
  return Object.freeze({ triggerAppEvent: input.triggerAppEvent });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the delivery itself.
 */
export function bindAppEvent(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): AppEventRuntimeOperations {
  return Object.freeze({
    triggerAppEvent: async (input: AppEventInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.open(input.eventUrl, { appBundleId: input.options?.appBundleId });
    },
  });
}
