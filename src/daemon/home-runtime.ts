import type { HomeInput } from '@agent-device/contracts/home-runtime';
import { homeRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** The neutral intent one `home` carries, projected from a resolved command context. */
function homeInput(context: DaemonCommandContext): HomeInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `home` reaches a device (ADR 0019). Admission inspects the exact owner's `home`
 * fact and binds once, before the dispatcher runs, so an owner that cannot navigate home is
 * refused rather than discovered mid-execution.
 */
export async function resolveBoundHomeRuntime(
  params: {
    device: DeviceInfo;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  return await resolveBoundGenericRuntime(
    {
      command: 'home',
      device: params.device,
      use: homeRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    executeHome,
  );
}

/**
 * The ONE place a bound `home` executes (R43). Typed off `typeof homeRuntimeUse` rather than a
 * hand-restated operations shape, so a change to what `home` binds can't silently drift here.
 */
async function executeHome(
  runtime: BoundDeviceRuntime<typeof homeRuntimeUse>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.home(homeInput(context));
  return { action: 'home', ...successText('Home') };
}
