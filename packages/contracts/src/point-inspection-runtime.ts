import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Point } from '@agent-device/kernel/snapshot';
import type { Interactor, PointInspectionRead, RunnerContext } from './interactor-types.ts';
import { invalidRuntimeContract } from './runtime-contract-error.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

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
