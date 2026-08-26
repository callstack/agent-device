import type { RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { DispatchContext } from './dispatch-context.ts';
import { getInteractor } from './interactors.ts';

export type { DispatchContext } from './dispatch-context.ts';
export { resolveTargetDevice, resolveTargetDeviceSelection } from './dispatch-resolve.ts';

/**
 * The legacy command dispatcher retired with R58: `settings` was its last arm, and every command
 * that once routed through it now admits its exact owner's facts and executes one bound
 * operation. What remains here is the single frame read that is not a command at all —
 * `replay`/`test` still consume it through `session-replay-maestro-runtime.ts` (ADR 0019 §6: a
 * shared helper stays in place until its last consumer can move).
 */
export async function dispatchGestureViewport(
  device: DeviceInfo,
  context?: DispatchContext,
): Promise<Rect | undefined> {
  const interactor = await getInteractor(device, runnerContextFromDispatchContext(context));
  return await interactor.gestureViewport?.();
}

function runnerContextFromDispatchContext(context?: DispatchContext): RunnerContext {
  return {
    requestId: context?.requestId,
    signal: context?.signal,
    appBundleId: context?.appBundleId,
    verbose: context?.verbose,
    logPath: context?.logPath,
    traceLogPath: context?.traceLogPath,
    iosXctestrunFile: context?.iosXctestrunFile,
    iosXctestDerivedDataPath: context?.iosXctestDerivedDataPath,
    iosXctestEnvDir: context?.iosXctestEnvDir,
    runnerLeaseContext: context?.runnerLeaseContext,
  };
}
