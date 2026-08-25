import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one clipboard read. The operation names no command, request, session, or CLI
 * flag: `clipboard read`'s whole input is the runner metadata every request-bound operation
 * forwards, which is why the read and the write share this base.
 */
export type ClipboardReadInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * One clipboard write. `text` is already joined and validated by the caller (`clipboard write`
 * accepts `""` to clear), so the owner receives content, never argv.
 */
export type ClipboardWriteInput = ClipboardReadInput & Readonly<{ text: string }>;

export type ClipboardReadRuntimeOperations = Readonly<{
  readClipboard(input: ClipboardReadInput): Promise<string>;
}>;

/**
 * The write returns nothing. The retired leaf discarded whatever the interactor answered and
 * reported only the length of the text it sent, so a result type here would be a surface the
 * command never had.
 */
export type ClipboardWriteRuntimeOperations = Readonly<{
  writeClipboard(input: ClipboardWriteInput): Promise<void>;
}>;

export type ClipboardRuntimeOperations = ClipboardReadRuntimeOperations &
  ClipboardWriteRuntimeOperations;

export type ClipboardRuntimeOperationFacts = Readonly<{
  readClipboard: RuntimeOperationFact;
  writeClipboard: RuntimeOperationFact;
}>;

/**
 * Read and write are separate cells because an owner can genuinely have one without the other —
 * a WebDriver provider whose Appium clipboard extension exposes only a getter is the real case —
 * and `clipboard read` must not be refused because the write half is missing.
 */
export function clipboardRuntimeOperationFacts(
  input: Readonly<{ read: RuntimeOperationFact; write: RuntimeOperationFact }>,
): ClipboardRuntimeOperationFacts {
  return Object.freeze({ readClipboard: input.read, writeClipboard: input.write });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both operations share: the runner context.
 */
async function resolveClipboardInteractor(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
  input: ClipboardReadInput,
): Promise<Interactor> {
  signal.throwIfAborted();
  return await resolveInteractor({
    ...input.execution,
    appBundleId: input.options?.appBundleId,
    signal,
  });
}

export function bindClipboardRead(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): ClipboardReadRuntimeOperations {
  return Object.freeze({
    readClipboard: async (input: ClipboardReadInput) => {
      const interactor = await resolveClipboardInteractor(signal, resolveInteractor, input);
      return await interactor.readClipboard();
    },
  });
}

export function bindClipboardWrite(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): ClipboardWriteRuntimeOperations {
  return Object.freeze({
    writeClipboard: async (input: ClipboardWriteInput) => {
      const interactor = await resolveClipboardInteractor(signal, resolveInteractor, input);
      await interactor.writeClipboard(input.text);
    },
  });
}
