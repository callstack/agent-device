import type { AppleRunnerRequestOptions } from '@agent-device/contracts/apple-runner-request';
import type { ElementSelectorKey } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from './utils/diagnostics.ts';

export async function inspectAppleRunnerSession(deviceId: string) {
  const { getRunnerSessionSnapshot } = await import('./platforms/apple/core/runner-client.ts');
  return getRunnerSessionSnapshot(deviceId);
}

export async function cleanupSessionlessAppleRunnerHost(device: DeviceInfo): Promise<void> {
  const { resolveRunnerAppBundleId, stopIosRunnerSession } =
    await import('./platforms/apple/core/runner-client.ts');
  await stopIosRunnerSession(device.id);
  const bundleId = resolveRunnerAppBundleId();
  const { closeIosApp } = await import('./platforms/apple/core/apps.ts');
  await closeIosApp(device, bundleId).catch((error) => {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_sessionless_runner_host_close_failed',
      data: {
        deviceId: device.id,
        bundleId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
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
