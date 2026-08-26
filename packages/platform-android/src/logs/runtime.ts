import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import {
  appLogCommandSucceeded,
  bestEffortAppLogCheck,
  createPidScopedAppLogRuntimeOwner,
  resolveFirstNumericAppLogPid,
} from '@agent-device/capture-kit';
import { assertAndroidLogPackageSafe } from './package-name.ts';
import { androidAppLogDescriptorCodec, createAndroidAppLogEnvelope } from './descriptor.ts';

const START_UNAVAILABLE_HINT =
  'The selected Android transport cannot start a background adb logcat stream.';

export function createAndroidAppLogRuntime(host: AppLogRuntimeHost) {
  return createPidScopedAppLogRuntimeOwner(host, {
    family: 'android',
    backend: 'android',
    label: 'Android',
    codec: androidAppLogDescriptorCodec,
    startUnavailableHint: START_UNAVAILABLE_HINT,
    cleanupFailureMessage: 'Android app-log cleanup did not settle every owned resource',
    doctor: async ({ host: runtimeHost, device, signal }, appBundleId) =>
      await doctorAndroidAppLogs(runtimeHost, device.id, appBundleId, signal),
    validateStart: ({ input }) => assertAndroidLogPackageSafe(input.appBundleId),
    process: async ({ host: runtimeHost, device, input }) => ({
      resolvePid: async (signal) =>
        await resolveFirstNumericAppLogPid(
          runtimeHost,
          androidPidRequest(device.id, input.appBundleId),
          signal,
        ),
      command: (pid) => ({
        kind: 'android-adb',
        serial: device.id,
        args: ['logcat', '-v', 'time', '--pid', pid],
        options: { allowFailure: true },
      }),
    }),
    descriptor: ({ artifacts, transport }) =>
      ({
        transport:
          transport.mode === 'transport-composed'
            ? 'android-logcat-transport-composed'
            : 'android-logcat-local',
        ...artifacts,
      }) as const,
    envelope: ({ input, device, owner, descriptor }) =>
      createAndroidAppLogEnvelope({
        sessionId: input.sessionId,
        device,
        owner,
        fence: input.fence,
        descriptor,
      }),
  });
}

async function doctorAndroidAppLogs(
  host: AppLogRuntimeHost,
  deviceId: string,
  appBundleId: string | undefined,
  signal: AbortSignal,
) {
  const checks: Record<string, boolean> = {};
  checks.adbAvailable = await bestEffortAppLogCheck(
    async () =>
      appLogCommandSucceeded(
        await host.commands.run(
          {
            executable: 'adb',
            args: ['-s', deviceId, 'shell', 'echo', 'ok'],
            allowFailure: true,
            timeoutMs: 1_000,
          },
          signal,
        ),
      ),
    signal,
  );
  if (appBundleId) {
    checks.androidPidVisible = await bestEffortAppLogCheck(
      async () =>
        Boolean(
          await resolveFirstNumericAppLogPid(
            host,
            androidPidRequest(deviceId, appBundleId),
            signal,
          ),
        ),
      signal,
    );
  }
  return {
    backend: 'android' as const,
    checks,
    notes: appBundleId
      ? []
      : ['No app bundle is tracked in this session. Run open <app> first for app-scoped logs.'],
  };
}

function androidPidRequest(deviceId: string, appBundleId: string) {
  return {
    executable: 'adb',
    args: ['-s', deviceId, 'shell', 'pidof', appBundleId],
    allowFailure: true,
    timeoutMs: 5_000,
  } as const;
}
