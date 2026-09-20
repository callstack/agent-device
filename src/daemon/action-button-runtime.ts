import {
  actionButtonRuntimeUse,
  type NoArgumentInteractorInput,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** The neutral intent one Action Button press carries, projected from a resolved command context. */
function actionButtonInput(context: DaemonCommandContext): NoArgumentInteractorInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `action-button` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `actionButton` fact and binds once, before the dispatcher runs, so an owner with no Action Button
 * is refused rather than discovered mid-execution.
 */
export async function resolveBoundActionButtonRuntime(
  params: {
    device: DeviceInfo;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  return await resolveBoundGenericRuntime(
    {
      command: 'action-button',
      device: params.device,
      use: actionButtonRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    executeActionButton,
  );
}

/**
 * The ONE place a bound `actionButton` executes. Typed off `typeof actionButtonRuntimeUse` rather
 * than a hand-restated operations shape, so a change to what the press binds can't drift here.
 *
 * The response carries no settle or observation payload by design: the press is expected to deliver
 * to whatever the system routes it to, including a backgrounded or terminated app (#2699).
 */
async function executeActionButton(
  runtime: BoundDeviceRuntime<typeof actionButtonRuntimeUse>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.actionButton(actionButtonInput(context));
  return { action: 'action-button', ...successText('Pressed Action Button') };
}
