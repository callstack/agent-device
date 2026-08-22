import { backRuntimeUse, type BackInput } from '@agent-device/contracts/platform';
import type { BackMode } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '../utils/success-text.ts';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** The neutral intent one `back` carries, projected from a resolved command context. */
function backInput(mode: BackMode | undefined, context: DaemonCommandContext): BackInput {
  return {
    mode,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `back` reaches a device (ADR 0019). Admission inspects the exact owner's `back`
 * fact and binds once, before the dispatcher runs, so an owner that cannot navigate back is
 * refused rather than discovered mid-execution.
 */
export async function resolveBoundBackRuntime(
  params: {
    device: DeviceInfo;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  return await resolveBoundGenericRuntime(
    {
      command: 'back',
      device: params.device,
      use: backRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    executeBack,
  );
}

/** The ONE place a bound `back` executes (R42). */
async function executeBack(
  runtime: Readonly<{ operations: Readonly<{ back: (input: BackInput) => Promise<void> }> }>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.back(backInput(context.backMode, context));
  return {
    action: 'back',
    mode: context.backMode ?? 'in-app',
    ...successText('Back'),
  };
}
