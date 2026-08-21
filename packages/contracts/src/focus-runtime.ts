import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Point } from '@agent-device/kernel/snapshot';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one point-addressed focus. The point is already resolved — from the
 * positionals a caller parsed, or from the node a selector matched — so the operation names no
 * command, request, session, or CLI flag.
 */
export type FocusPointInput = Readonly<{
  point: Point;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * Focus returns nothing. The legacy leaf discarded whatever the interactor answered and reported
 * only the point it addressed, so a result type here would be a surface the command never had.
 */
export type FocusRuntimeOperations = Readonly<{
  focusPoint(input: FocusPointInput): Promise<void>;
}>;

export type FocusRuntimeOperationFacts = Readonly<{
  focusPoint: RuntimeOperationFact;
}>;

export function focusRuntimeOperationFacts(
  input: Readonly<{ focus: RuntimeOperationFact }>,
): FocusRuntimeOperationFacts {
  return Object.freeze({ focusPoint: input.focus });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the focus itself.
 */
function bindFocusPoint(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): FocusRuntimeOperations {
  return Object.freeze({
    focusPoint: async (input: FocusPointInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.focus(input.point.x, input.point.y);
    },
  });
}

export type LocalFocusInteractorResolver = LocalInteractorOperationResolver;

export function bindLocalFocusInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalFocusInteractorResolver;
  }>,
): FocusRuntimeOperations {
  return bindFocusPoint(params.signal, localInteractorSource(params));
}

export type ProviderFocusInteractorResolver = ProviderInteractorOperationResolver;

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderFocusInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderFocusInteractorResolver;
  }>,
): FocusRuntimeOperations {
  return bindFocusPoint(params.signal, providerInteractorSource({ ...params, operation: 'focus' }));
}
