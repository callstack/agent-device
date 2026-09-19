import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one Action Button press: no arguments, because `XCUIDevice.press(.action)`
 * takes none. Only runner metadata travels, so this is `home`'s shape — the two differ in what
 * they do to the device, not in what they carry.
 */
export type ActionButtonInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/** The press returns nothing; a result type here would be a surface the command never has. */
export type ActionButtonRuntimeOperations = Readonly<{
  actionButton(input: ActionButtonInput): Promise<void>;
}>;

export type ActionButtonRuntimeOperationFacts = Readonly<{
  actionButton: RuntimeOperationFact;
}>;

export function actionButtonRuntimeOperationFacts(
  input: Readonly<{ actionButton: RuntimeOperationFact }>,
): ActionButtonRuntimeOperationFacts {
  return Object.freeze({ actionButton: input.actionButton });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding.
 *
 * The member is required rather than optional even though only Apple can press the button, which is
 * how `tvRemote` already handles a button only some owners have. An optional member would turn a
 * fact that advertises the press without an interactor that performs it into a successful-looking
 * no-op, and the response would report a press that never happened. Owners without the hardware
 * declare the refusal on the interactor, and the fact is what keeps that throw off every supported
 * path.
 */
export function bindActionButton(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): ActionButtonRuntimeOperations {
  return Object.freeze({
    actionButton: async (input: ActionButtonInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.actionButton();
    },
  });
}
