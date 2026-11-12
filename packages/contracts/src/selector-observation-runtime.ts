import type { Rect, SnapshotNativePressTarget } from '@agent-device/kernel/snapshot';
import type { ElementSelectorKey } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SessionSurface } from './session-surface.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

type ObservationInput = Readonly<{
  options?: Readonly<{ appBundleId?: string; surface?: SessionSurface }>;
  execution?: SnapshotRuntimeExecution;
  signal?: AbortSignal;
}>;

export type FindTextInput = ObservationInput & Readonly<{ text: string }>;

/** A canonical resolution's target; this read never chooses a substitute by label or hittability. */
export type AuthorizedPressTarget = Readonly<SnapshotNativePressTarget>;

export type NativePressReadiness =
  | 'ready'
  | 'blocked'
  | 'missing'
  | 'ambiguous'
  | 'surface-mismatch';

export type QuerySelectorInput = ObservationInput &
  Readonly<{ selector: Readonly<{ key: ElementSelectorKey; value: string }> }>;

export type PressReadinessInput = Readonly<{
  authorizedTarget: AuthorizedPressTarget;
  appBundleId: string;
  execution: SnapshotRuntimeExecution;
  signal?: AbortSignal;
}>;

export type PressReadinessResult = Readonly<{
  readiness: NativePressReadiness;
  appBundleId?: string;
}>;

export type PressReadinessRuntimeOperations = Readonly<{
  pressReadiness(input: PressReadinessInput): Promise<PressReadinessResult>;
}>;

/**
 * Positive native observations are authoritative and preserve matches that an advertising owner's
 * bulk capture may omit. A negative observation means only "not proven by this owner"; the caller
 * must still consult its required canonical capture. Owners without a native text source report
 * that conditional operation unavailable and rely on their parity-proven capture path.
 */
export type SelectorObservationResult = Readonly<{ found: boolean }>;
export type FindTextResult = SelectorObservationResult;

/**
 * The live geometry the owner read for the matched node, projected to the two fields the
 * off-screen rescue consumes. Owners without a node-scoped live read report the operation
 * unavailable; the caller then refuses on its bulk-tree verdict unchanged.
 */
export type QuerySelectorNodeReading = Readonly<{
  rect: Rect;
  hittable: boolean;
}>;

export type QuerySelectorResult = SelectorObservationResult &
  Readonly<{ node?: QuerySelectorNodeReading }>;

export type SelectorObservationRuntimeOperations = Readonly<{
  findText(input: FindTextInput): Promise<FindTextResult>;
  querySelector(input: QuerySelectorInput): Promise<QuerySelectorResult>;
}>;
export type FindTextRuntimeOperations = Pick<SelectorObservationRuntimeOperations, 'findText'>;
export type QuerySelectorRuntimeOperations = Pick<
  SelectorObservationRuntimeOperations,
  'querySelector'
>;

export type SelectorObservationRuntimeOperationFacts = Readonly<{
  findText: RuntimeOperationFact;
  querySelector: RuntimeOperationFact;
}>;

export function selectorObservationRuntimeOperationFacts(
  input: SelectorObservationRuntimeOperationFacts,
): SelectorObservationRuntimeOperationFacts {
  return Object.freeze({
    findText: input.findText,
    querySelector: input.querySelector,
  });
}
