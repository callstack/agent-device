import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';

export function buildOpenTargetDeviceResolutionOptions(
  openTarget: string | undefined,
  env: EnvMap,
): ResolveTargetDeviceOptions {
  return {
    env,
    appleSimulatorAppTarget: appleSimulatorAppTargetForOpenTarget(openTarget),
  };
}

export function appleSimulatorAppTargetForOpenTarget(
  openTarget: string | undefined,
): string | undefined {
  return openTarget && !isDeepLinkTarget(openTarget) ? openTarget : undefined;
}
