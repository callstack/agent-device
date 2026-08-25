import type { AlertInteractorOptions, Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SessionSurface } from './session-surface.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one alert leg. Nothing command-shaped travels here: the daemon has already
 * parsed the subcommand, chosen which of the four operations to bind, and turned the CLI's
 * optional timeout positional into a millisecond window.
 *
 * `appBundleId` and `surface` are the session's own target, forwarded as the pair the owner
 * needs — a macOS frontmost-app session deliberately carries no bundle, and collapsing the two
 * into one field would lose that.
 */
export type AlertRuntimeInput = Readonly<{
  /** The whole window this request allows the owner; absent means the owner's own default. */
  timeoutMs?: number;
  appBundleId?: string;
  surface?: SessionSurface;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * Owners answer with their own alert payload — Android's discriminated `alertStatus`/`alertWait`/
 * `alertHandled` records, the XCTest runner's alert fields, the macOS helper's. The daemon
 * composes the response around whichever it gets, exactly as the retired leaf did.
 */
export type AlertReadRuntimeOperations = Readonly<{
  readAlert(input: AlertRuntimeInput): Promise<Record<string, unknown>>;
}>;

export type AlertWaitRuntimeOperations = Readonly<{
  awaitAlert(input: AlertRuntimeInput): Promise<Record<string, unknown>>;
}>;

export type AlertAcceptRuntimeOperations = Readonly<{
  acceptAlert(input: AlertRuntimeInput): Promise<Record<string, unknown>>;
}>;

export type AlertDismissRuntimeOperations = Readonly<{
  dismissAlert(input: AlertRuntimeInput): Promise<Record<string, unknown>>;
}>;

export type AlertRuntimeOperations = AlertReadRuntimeOperations &
  AlertWaitRuntimeOperations &
  AlertAcceptRuntimeOperations &
  AlertDismissRuntimeOperations;

export type AlertRuntimeOperationFacts = Readonly<{
  readAlert: RuntimeOperationFact;
  awaitAlert: RuntimeOperationFact;
  acceptAlert: RuntimeOperationFact;
  dismissAlert: RuntimeOperationFact;
}>;

/**
 * Four cells rather than one, because the daemon binds exactly the leg the parsed subcommand
 * names (ADR 0019 §9). No owner today observes an alert it cannot act on, so every owner passes
 * the same fact four times — but a partial owner would then refuse only the legs it lacks, rather
 * than taking the whole command down with it.
 */
export function alertRuntimeOperationFacts(
  input: Readonly<{
    read: RuntimeOperationFact;
    wait: RuntimeOperationFact;
    accept: RuntimeOperationFact;
    dismiss: RuntimeOperationFact;
  }>,
): AlertRuntimeOperationFacts {
  return Object.freeze({
    readAlert: input.read,
    awaitAlert: input.wait,
    acceptAlert: input.accept,
    dismissAlert: input.dismiss,
  });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what all four legs share: the runner context and the target.
 */
async function resolveAlertInteractor(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
  input: AlertRuntimeInput,
): Promise<Interactor> {
  signal.throwIfAborted();
  return await resolveInteractor({
    ...input.execution,
    appBundleId: input.appBundleId,
    signal,
  });
}

function alertInteractorOptions(input: AlertRuntimeInput): AlertInteractorOptions {
  return {
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.appBundleId === undefined ? {} : { appBundleId: input.appBundleId }),
    ...(input.surface === undefined ? {} : { surface: input.surface }),
  };
}

type AlertLeg = 'readAlert' | 'awaitAlert' | 'acceptAlert' | 'dismissAlert';

export function bindAlertLeg<Leg extends AlertLeg>(
  leg: Leg,
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Readonly<Record<Leg, (input: AlertRuntimeInput) => Promise<Record<string, unknown>>>> {
  return Object.freeze({
    [leg]: async (input: AlertRuntimeInput) => {
      const interactor = await resolveAlertInteractor(signal, resolveInteractor, input);
      return await interactor[leg](alertInteractorOptions(input));
    },
  }) as Readonly<Record<Leg, (input: AlertRuntimeInput) => Promise<Record<string, unknown>>>>;
}
