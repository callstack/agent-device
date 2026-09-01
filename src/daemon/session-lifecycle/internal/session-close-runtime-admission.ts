import {
  closeApplicationRuntimeUse,
  closeApplicationWithRuntimeHintClearUse,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonResponse } from '../../types.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { admitRuntimeOperations } from '../../runtime-admission.ts';

export type CloseRuntime = BoundDeviceRuntime<typeof closeApplicationRuntimeUse>;
export type CloseRuntimeWithRuntimeHintClear = BoundDeviceRuntime<
  typeof closeApplicationWithRuntimeHintClearUse
>;
export type RuntimeHintClearOperation =
  CloseRuntimeWithRuntimeHintClear['operations']['clearRuntimeHints'];

export type CloseRuntimeAdmission =
  | Readonly<{
      type: 'runtime';
      runtime: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
      clearRuntimeHints?: RuntimeHintClearOperation;
    }>
  | Readonly<{ type: 'response'; response: DaemonResponse }>;

// The only facts admission and implementation binding in the close handler. It checks the whole
// close/finalization use before an implementation loads, so a fact gap cannot dispatch close and
// only then discover that durable cleanup is unavailable.
export async function admitCloseRuntime(params: {
  device: DeviceInfo;
  clearRuntimeHints: boolean;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<CloseRuntimeAdmission> {
  const use = params.clearRuntimeHints
    ? closeApplicationWithRuntimeHintClearUse
    : closeApplicationRuntimeUse;
  const admitted = await admitRuntimeOperations({
    ...params,
    command: 'close',
    required: use.required,
  });
  if (admitted.type === 'response') return admitted;
  if (!params.clearRuntimeHints) {
    return {
      type: 'runtime',
      runtime: await admitted.bind(params.device, closeApplicationRuntimeUse),
    };
  }
  const runtime = await admitted.bind(params.device, closeApplicationWithRuntimeHintClearUse);
  return { type: 'runtime', runtime, clearRuntimeHints: runtime.operations.clearRuntimeHints };
}
