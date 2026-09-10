import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SessionSurface } from './session-surface.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

type ObservationInput = Readonly<{
  options?: Readonly<{ appBundleId?: string; surface?: SessionSurface }>;
  execution?: SnapshotRuntimeExecution;
  signal?: AbortSignal;
}>;

export type FindTextInput = ObservationInput & Readonly<{ text: string }>;

/**
 * Positive native observations are authoritative and preserve matches that an advertising owner's
 * bulk capture may omit. A negative observation means only "not proven by this owner"; the caller
 * must still consult its required canonical capture. Owners without a native text source report
 * that conditional operation unavailable and rely on their parity-proven capture path.
 */
export type SelectorObservationResult = Readonly<{ found: boolean }>;
export type FindTextResult = SelectorObservationResult;

export type SelectorObservationRuntimeOperations = Readonly<{
  findText(input: FindTextInput): Promise<FindTextResult>;
}>;
export type FindTextRuntimeOperations = Pick<SelectorObservationRuntimeOperations, 'findText'>;

export type SelectorObservationRuntimeOperationFacts = Readonly<{
  findText: RuntimeOperationFact;
}>;

export function selectorObservationRuntimeOperationFacts(
  input: SelectorObservationRuntimeOperationFacts,
): SelectorObservationRuntimeOperationFacts {
  return Object.freeze({ findText: input.findText });
}
