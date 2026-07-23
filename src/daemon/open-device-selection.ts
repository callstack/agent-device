import { isDeepLinkTarget } from '../contracts/open-target.ts';
import type { ResolveTargetDeviceOptions } from '../core/dispatch-resolve.ts';

export function buildOpenTargetDeviceResolutionOptions(
  openTarget: string | undefined,
): ResolveTargetDeviceOptions {
  return {
    appleSimulatorAppTarget: openTarget && !isDeepLinkTarget(openTarget) ? openTarget : undefined,
  };
}
