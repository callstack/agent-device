import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';

export function buildOpenTargetDeviceResolutionOptions(
  openTarget: string | undefined,
): ResolveTargetDeviceOptions {
  return {
    appleSimulatorAppTarget: appleSimulatorAppTargetForOpenTarget(openTarget),
  };
}

export function appleSimulatorAppTargetForOpenTarget(
  openTarget: string | undefined,
): string | undefined {
  return openTarget && !isDeepLinkTarget(openTarget) ? openTarget : undefined;
}
