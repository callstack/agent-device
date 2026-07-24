import { isDeepLinkTarget } from '../contracts/open-target.ts';
import type { ResolveTargetDeviceOptions } from '../core/dispatch-resolve.ts';

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
