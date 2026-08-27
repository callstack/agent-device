import type { AppleRunnerRequestOptions } from '@agent-device/contracts/apple-runner-request';
import type { ElementSelectorKey } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function inspectAppleRunnerSession(deviceId: string) {
  const { getRunnerSessionSnapshot } = await import('./platforms/apple/core/runner-client.ts');
  return getRunnerSessionSnapshot(deviceId);
}

export async function queryAppleRuntimeSelector(
  device: DeviceInfo,
  selector: Readonly<{ key: ElementSelectorKey; value: string }>,
  appBundleId: string | undefined,
  options: AppleRunnerRequestOptions,
): Promise<Record<string, unknown>> {
  const { queryAppleRunnerSelector } =
    await import('./platforms/apple/core/runner-selector-query.ts');
  return await queryAppleRunnerSelector(device, selector, appBundleId, options);
}
