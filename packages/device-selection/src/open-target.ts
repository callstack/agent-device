import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';

export function buildOpenTargetDeviceResolutionOptions(
  openTarget: string | undefined,
  env: EnvMap,
  surfaceFlag: string | undefined,
): ResolveTargetDeviceOptions {
  const appTarget = appleSimulatorAppTargetForOpenTarget(openTarget);
  return {
    env,
    appleSimulatorAppTarget: appTarget,
    // An app named on any other surface stays on the host: those surfaces reach past one app.
    ...(appTarget && (surfaceFlag === undefined || surfaceFlag === 'app')
      ? { appDeviceTarget: appTarget }
      : {}),
  };
}

export function appleSimulatorAppTargetForOpenTarget(
  openTarget: string | undefined,
): string | undefined {
  return openTarget && !isDeepLinkTarget(openTarget) ? openTarget : undefined;
}
