import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type {
  Interactor,
  KeyboardDismissResult,
  KeyboardEnterResult,
  KeyboardStatusResult,
  RunnerContext,
} from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

export type { KeyboardDismissResult, KeyboardEnterResult, KeyboardStatusResult };

/**
 * Neutral intent for one keyboard probe/action. Every keyboard operation takes the same shape —
 * runner metadata only, no arguments — so one input type covers all three; the action itself is
 * which operation the caller invokes, decided by the daemon's action-selected bind (ADR 0019 §9),
 * never by an argument threaded through here.
 */
export type KeyboardActionInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

export type KeyboardStatusRuntimeOperations = Readonly<{
  keyboardStatus(input: KeyboardActionInput): Promise<KeyboardStatusResult>;
}>;
export type KeyboardDismissRuntimeOperations = Readonly<{
  keyboardDismiss(input: KeyboardActionInput): Promise<KeyboardDismissResult>;
}>;
export type KeyboardEnterRuntimeOperations = Readonly<{
  keyboardEnter(input: KeyboardActionInput): Promise<KeyboardEnterResult>;
}>;

export type KeyboardRuntimeOperations = KeyboardStatusRuntimeOperations &
  KeyboardDismissRuntimeOperations &
  KeyboardEnterRuntimeOperations;

export type KeyboardRuntimeOperationFacts = Readonly<{
  keyboardStatus: RuntimeOperationFact;
  keyboardDismiss: RuntimeOperationFact;
  keyboardEnter: RuntimeOperationFact;
}>;

export function keyboardRuntimeOperationFacts(
  input: Readonly<{
    status: RuntimeOperationFact;
    dismiss: RuntimeOperationFact;
    enter: RuntimeOperationFact;
  }>,
): KeyboardRuntimeOperationFacts {
  return Object.freeze({
    keyboardStatus: input.status,
    keyboardDismiss: input.dismiss,
    keyboardEnter: input.enter,
  });
}

/**
 * `Interactor.keyboardStatus`/`keyboardDismiss`/`keyboardEnter` are optional (parity with
 * `hover`): a platform with no keyboard concept for that action leaves it undefined. Facts admit
 * an operation only for owners whose interactor implements it, so a missing method at bind time
 * is a runtime-contract error, not a normal refusal.
 */
function requireKeyboardMethod<Method>(
  method: Method | undefined,
  operation: string,
): NonNullable<Method> {
  if (method) return method as NonNullable<Method>;
  throw new AppError(
    'COMMAND_FAILED',
    `${operation} was admitted but its bound interactor has no implementation.`,
    { reason: 'interactor-method-missing' },
  );
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the probe itself.
 */
function bindKeyboardStatus(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): KeyboardStatusRuntimeOperations {
  return Object.freeze({
    keyboardStatus: async (input: KeyboardActionInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      return await requireKeyboardMethod(interactor.keyboardStatus, 'keyboard status').call(
        interactor,
      );
    },
  });
}

function bindKeyboardDismiss(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): KeyboardDismissRuntimeOperations {
  return Object.freeze({
    keyboardDismiss: async (input: KeyboardActionInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      return await requireKeyboardMethod(interactor.keyboardDismiss, 'keyboard dismiss').call(
        interactor,
      );
    },
  });
}

function bindKeyboardEnter(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): KeyboardEnterRuntimeOperations {
  return Object.freeze({
    keyboardEnter: async (input: KeyboardActionInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      return await requireKeyboardMethod(interactor.keyboardEnter, 'keyboard enter').call(
        interactor,
      );
    },
  });
}

export type LocalKeyboardInteractorResolver = LocalInteractorOperationResolver;
export type ProviderKeyboardInteractorResolver = ProviderInteractorOperationResolver;

export function bindLocalKeyboardStatusInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalKeyboardInteractorResolver;
  }>,
): KeyboardStatusRuntimeOperations {
  return bindKeyboardStatus(params.signal, localInteractorSource(params));
}

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderKeyboardStatusInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderKeyboardInteractorResolver;
  }>,
): KeyboardStatusRuntimeOperations {
  return bindKeyboardStatus(
    params.signal,
    providerInteractorSource({ ...params, operation: 'keyboard status' }),
  );
}

export function bindLocalKeyboardDismissInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalKeyboardInteractorResolver;
  }>,
): KeyboardDismissRuntimeOperations {
  return bindKeyboardDismiss(params.signal, localInteractorSource(params));
}

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderKeyboardDismissInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderKeyboardInteractorResolver;
  }>,
): KeyboardDismissRuntimeOperations {
  return bindKeyboardDismiss(
    params.signal,
    providerInteractorSource({ ...params, operation: 'keyboard dismiss' }),
  );
}

export function bindLocalKeyboardEnterInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalKeyboardInteractorResolver;
  }>,
): KeyboardEnterRuntimeOperations {
  return bindKeyboardEnter(params.signal, localInteractorSource(params));
}

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderKeyboardEnterInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderKeyboardInteractorResolver;
  }>,
): KeyboardEnterRuntimeOperations {
  return bindKeyboardEnter(
    params.signal,
    providerInteractorSource({ ...params, operation: 'keyboard enter' }),
  );
}
