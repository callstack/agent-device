import { AppError } from '@agent-device/kernel/errors';
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
 * resolution and this holds only what all three actions share: the runner context resolution.
 */
async function resolveKeyboardInteractor(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
  input: KeyboardActionInput,
): Promise<Interactor> {
  signal.throwIfAborted();
  return await resolveInteractor({
    ...input.execution,
    appBundleId: input.options?.appBundleId,
    signal,
  });
}

export const KEYBOARD_ACTION_LABELS = {
  keyboardStatus: 'keyboard status',
  keyboardDismiss: 'keyboard dismiss',
  keyboardEnter: 'keyboard enter',
} as const satisfies Record<keyof KeyboardRuntimeOperations, string>;

/**
 * Binds whichever keyboard action `key` names against one resolved interactor. The three actions
 * differ only by which `Interactor` method they call and what it returns — both read off `key`
 * itself, so one generic body replaces three copies that differed by nothing else.
 */
export function bindKeyboardAction<Key extends keyof KeyboardRuntimeOperations>(
  key: Key,
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Pick<KeyboardRuntimeOperations, Key> {
  const action = async (input: KeyboardActionInput) => {
    const interactor = await resolveKeyboardInteractor(signal, resolveInteractor, input);
    const method = requireKeyboardMethod(interactor[key], KEYBOARD_ACTION_LABELS[key]);
    return await (method as () => Promise<unknown>).call(interactor);
  };
  return Object.freeze({ [key]: action }) as Pick<KeyboardRuntimeOperations, Key>;
}
