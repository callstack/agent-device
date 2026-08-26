import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import { appLogCommandSucceeded, bestEffortAppLogCheck } from '@agent-device/capture-kit';
import { APPLE_XCTEST_LOGS_HINT, backendForAppleDevice } from './backend.ts';
import {
  checkCoreDeviceConsoleCaptureSupport,
  IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED,
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED,
} from './coredevice-console.ts';

export async function doctorAppleAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  appBundleId: string | undefined,
  signal?: AbortSignal,
) {
  const checks: Record<string, boolean> = {};
  const notes = appBundleId
    ? []
    : ['No app bundle is tracked in this session. Run open <app> first for app-scoped logs.'];
  if (isMacOs(device)) {
    checks.logAvailable = Boolean(await host.commands.which('log'));
  } else if (device.kind === 'simulator') {
    checks.simctlAvailable = await bestEffortAppLogCheck(
      async () =>
        appLogCommandSucceeded(
          await host.appleTools.run(
            {
              tool: 'simctl',
              args: ['help'],
              allowFailure: true,
            },
            signal,
          ),
        ),
      signal,
    );
  } else if (device.iosPhysicalDeviceBackend === 'xctest') {
    checks.devicectlAvailable = false;
    checks.devicectlConsoleCapture = false;
    notes.push(APPLE_XCTEST_LOGS_HINT);
  } else {
    checks.devicectlAvailable = await bestEffortAppLogCheck(
      async () =>
        appLogCommandSucceeded(
          await host.appleTools.run(
            {
              tool: 'devicectl',
              args: ['--version'],
              allowFailure: true,
            },
            signal,
          ),
        ),
      signal,
    );
    const support = await checkCoreDeviceConsoleCaptureSupport(host, signal);
    checks.devicectlConsoleCapture = support.supported;
    if (!support.supported) {
      const message =
        support.reason === 'unsupported'
          ? IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED
          : IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED;
      notes.push(`${message.message} ${message.hint}`);
    }
  }
  return { backend: backendForAppleDevice(device), checks, notes };
}
