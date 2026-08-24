import type { AppSwitcherInput } from '@agent-device/contracts/app-switcher-runtime';
import { appSwitcherRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '../utils/success-text.ts';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** The neutral intent one `app-switcher` carries, projected from a resolved command context. */
function appSwitcherInput(context: DaemonCommandContext): AppSwitcherInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `app-switcher` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `appSwitcher` fact and binds once, before the dispatcher runs, so an owner with no springboard
 * to reveal is refused rather than discovered mid-execution.
 */
export async function resolveBoundAppSwitcherRuntime(
  params: {
    device: DeviceInfo;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  return await resolveBoundGenericRuntime(
    {
      command: 'app-switcher',
      device: params.device,
      use: appSwitcherRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    executeAppSwitcher,
  );
}

/**
 * The ONE place a bound `app-switcher` executes (R56). Typed off `typeof appSwitcherRuntimeUse`
 * rather than a hand-restated operations shape, so a change to what it binds can't drift here.
 */
async function executeAppSwitcher(
  runtime: BoundDeviceRuntime<typeof appSwitcherRuntimeUse>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.appSwitcher(appSwitcherInput(context));
  return { action: 'app-switcher', ...successText('Opened app switcher') };
}
