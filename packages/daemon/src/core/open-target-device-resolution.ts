import type { EnvMap } from '@agent-device/kernel/source-value';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';
import { buildOpenTargetDeviceResolutionOptions } from '@agent-device/device-selection/open-target';
import type { DaemonRequest } from './daemon-request.ts';
import { resolveCommandAndroidAvdSelection } from './daemon-command-registry.ts';

/**
 * The device resolution of an `open` request. The request lock, bounded claim recovery, provider
 * context and the open handler all resolve through here, so they select the same device.
 * A stopped AVD is a candidate only when `--device` names a device: device ranking prefers a
 * virtual device over a booted one, so an unnamed open would otherwise boot a stopped AVD over a
 * running phone.
 */
export function resolveOpenTargetDeviceOptions(
  req: Pick<DaemonRequest, 'positionals' | 'flags'>,
  env: EnvMap,
): ResolveTargetDeviceOptions {
  return buildOpenTargetDeviceResolutionOptions(
    req.positionals?.[0],
    env,
    req.flags?.surface,
    req.flags?.device ? resolveCommandAndroidAvdSelection('open') : 'running-only',
  );
}
