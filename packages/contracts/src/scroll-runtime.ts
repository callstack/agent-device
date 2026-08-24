import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { ResolvedScrollExecutionOptions } from './scroll-command.ts';
import type { ScrollDirection } from './scroll-gesture.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one directional scroll. Distance, timing, and release behavior are already
 * resolved by the caller (`resolveScrollExecutionOptions`), so the owner receives them as data
 * and the operation names no command, request, session, or CLI flag.
 */
export type ScrollDirectionInput = Readonly<{
  direction: ScrollDirection;
  options: ResolvedScrollExecutionOptions;
  target?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * One scroll pass. `scroll top` / `scroll bottom` run several, verifying between passes with the
 * capture operation they additionally require — the platform-visible unit is still a single pass,
 * so edge repetition stays caller-side policy rather than a second operation.
 */
export type ScrollRuntimeOperations = Readonly<{
  scrollDirection(input: ScrollDirectionInput): Promise<Record<string, unknown> | void>;
}>;

export type ScrollRuntimeOperationFacts = Readonly<{
  scrollDirection: RuntimeOperationFact;
}>;

export function scrollRuntimeOperationFacts(
  input: Readonly<{ scroll: RuntimeOperationFact }>,
): ScrollRuntimeOperationFacts {
  return Object.freeze({ scrollDirection: input.scroll });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the scroll itself.
 */
function bindScrollDirection(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): ScrollRuntimeOperations {
  return Object.freeze({
    scrollDirection: async (input: ScrollDirectionInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.target?.appBundleId,
        signal,
      });
      return await interactor.scroll(input.direction, input.options);
    },
  });
}

export type LocalScrollInteractorResolver = LocalInteractorOperationResolver;

export function bindLocalScrollInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalScrollInteractorResolver;
  }>,
): ScrollRuntimeOperations {
  return bindScrollDirection(params.signal, localInteractorSource(params));
}

export type ProviderScrollInteractorResolver = ProviderInteractorOperationResolver;

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderScrollInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderScrollInteractorResolver;
  }>,
): ScrollRuntimeOperations {
  return bindScrollDirection(
    params.signal,
    providerInteractorSource({ ...params, operation: 'scroll' }),
  );
}
