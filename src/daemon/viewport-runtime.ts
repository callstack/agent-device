import { readViewportDimensions } from '@agent-device/contracts/capture';
import { viewportRuntimeUse } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from './runtime-admission.ts';

export async function resolveBoundViewportRuntime(
  params: {
    device: DeviceInfo;
    positionals: string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const input = readViewportDimensions(params.positionals);
  const admission = await admitRuntimeUse({
    command: 'viewport',
    device: params.device,
    use: viewportRuntimeUse,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  return {
    ok: true,
    execute: async () => {
      await admission.runtime.operations.setViewport(input);
      return { ...input, message: `Viewport set: ${input.width}x${input.height}` };
    },
  };
}
