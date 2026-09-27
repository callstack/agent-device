import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Point } from '@agent-device/kernel/snapshot';
import type { Interactor, PointInspectionRead, RunnerContext } from './interactor-types.ts';
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

export type InspectPointRuntimeInput = Readonly<{
  point: Point;
  options?: Readonly<{ appBundleId?: string }>;
  execution?: SnapshotRuntimeExecution;
}>;

export type PointInspectionRuntimeOperations = Readonly<{
  inspectPoint(input: InspectPointRuntimeInput): Promise<PointInspectionRead>;
}>;

export type PointInspectionRuntimeOperationFacts = Readonly<{
  inspectPoint: RuntimeOperationFact;
}>;

export function pointInspectionRuntimeOperationFacts(
  input: PointInspectionRuntimeOperationFacts,
): PointInspectionRuntimeOperationFacts {
  return Object.freeze({ inspectPoint: input.inspectPoint });
}

export function bindPointInspectionRuntime(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: (device: DeviceInfo, runner: RunnerContext) => Promise<Interactor>;
  }>,
): PointInspectionRuntimeOperations {
  return Object.freeze({
    inspectPoint: async (input) => {
      params.signal.throwIfAborted();
      const interactor = await params.resolveInteractor(params.device, {
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal: params.signal,
      });
      if (typeof interactor.inspectPoint !== 'function') {
        const { invalidRuntimeContract } = await import('./runtime-contract-error.ts');
        throw invalidRuntimeContract(
          'Runtime owner advertised inspectPoint without an interactor implementation',
        );
      }
      return await interactor.inspectPoint(input.point, {
        appBundleId: input.options?.appBundleId,
        signal: params.signal,
      });
    },
  });
}
