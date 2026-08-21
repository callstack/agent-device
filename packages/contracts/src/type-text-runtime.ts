import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext, TypeTextBackendResult } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one focus-target text entry. The text goes wherever the platform's current
 * first responder is — targeting happened before this operation (a `focus`/`press`, or find's
 * resolution) — so the operation names no command, request, session, or CLI flag. `delayMs` is
 * already validated by the caller; the owner receives it as data.
 */
export type TypeTextInput = Readonly<{
  text: string;
  delayMs: number;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * The operation returns the interactor's own closed result: only the Apple runner reports which
 * text-entry route it took; every other owner types blind and returns nothing (`interactor-types`
 * owns that contract and its Swift route-parity test).
 */
export type TypeTextRuntimeOperations = Readonly<{
  typeText(input: TypeTextInput): Promise<TypeTextBackendResult | void>;
}>;

export type TypeTextRuntimeOperationFacts = Readonly<{
  typeText: RuntimeOperationFact;
}>;

export function typeTextRuntimeOperationFacts(
  input: Readonly<{ type: RuntimeOperationFact }>,
): TypeTextRuntimeOperationFacts {
  return Object.freeze({ typeText: input.type });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the entry itself.
 */
function bindTypeText(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): TypeTextRuntimeOperations {
  return Object.freeze({
    typeText: async (input: TypeTextInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      return await interactor.type(input.text, input.delayMs);
    },
  });
}

export type LocalTypeTextInteractorResolver = LocalInteractorOperationResolver;

export function bindLocalTypeTextInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalTypeTextInteractorResolver;
  }>,
): TypeTextRuntimeOperations {
  return bindTypeText(params.signal, localInteractorSource(params));
}

export type ProviderTypeTextInteractorResolver = ProviderInteractorOperationResolver;

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderTypeTextInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderTypeTextInteractorResolver;
  }>,
): TypeTextRuntimeOperations {
  return bindTypeText(params.signal, providerInteractorSource({ ...params, operation: 'type' }));
}
