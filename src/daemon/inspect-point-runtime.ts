import { inspectPointRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { readPointPositionals } from '@agent-device/kernel/validation';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

export async function resolveBoundInspectPointRuntime(
  params: {
    device: DeviceInfo;
    positionals: string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const point = readPointPositionals(params.positionals, 'inspect-point requires x y');
  return await resolveBoundGenericRuntime(
    {
      command: 'inspect-point',
      device: params.device,
      use: inspectPointRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    async (runtime, context: DaemonCommandContext) => {
      const result = await runtime.operations.inspectPoint({
        point,
        ...(context.appBundleId ? { options: { appBundleId: context.appBundleId } } : {}),
        execution: runtimeExecutionFromContext(context),
      });
      const [first, ...rest] = result.elements;
      return first === undefined
        ? { status: 'no-element-at-point', point, elements: [] }
        : { status: 'inspected', point, elements: [first, ...rest] };
    },
  );
}
