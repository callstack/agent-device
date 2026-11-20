import type {
  DeviceProviderPluginHost,
  ProviderHostCapabilities,
} from 'agent-device/plugins/device-host';
import { createLimrunIosAppLogReader } from './ios-app-logs.ts';
import type { LimrunIosHost } from './ios-host.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

/** The `error.details.reason` values a Limrun host refusal publishes. */
const LIMRUN_HOST_REASONS = {
  capabilityMissing: 'provider_host_capability_missing',
} as const satisfies Record<string, string>;

/**
 * Answers what the runtime asks for from the host it is set up on. The Android interactor, the ADB
 * mechanics and the shared XCTest runner are the host's own, bound here to the executor or the
 * simulator this provider reaches its lease through. The Android facet loads with the runtime
 * because `getInteractor` answers synchronously; the Apple facet loads with the first iOS lease.
 */
export async function createLimrunRuntimeDependencies(
  host: DeviceProviderPluginHost,
): Promise<LimrunRuntimeDependencies> {
  const { emitDiagnostic, loadAndroid, loadApple, loadHostKit } = requireHostCapabilities(host);
  const android = await loadAndroid();
  const loadIosHost = async (): Promise<LimrunIosHost> => {
    const [apple, kit] = await Promise.all([loadApple(), loadHostKit()]);
    return {
      apple,
      kit,
      env: host.env,
      clientVersion: host.clientVersion,
      emitDiagnostic,
    };
  };
  return {
    clientVersion: host.clientVersion,
    android: {
      bindPerformance: android.bindPerformance,
      bindDeployment: android.bindDeployment,
      createInteractor: android.createLeaseInteractor,
      createPortReverse: async (adb, options) => android.createPortReverse(adb, options),
      inferAppName: async (packageName) => android.inferAppName(packageName),
      listApps: android.listApps,
      getForegroundApp: async (_device, adb, signal) => await android.getForegroundApp(adb, signal),
      getKeyboardState: android.getKeyboardState,
      dismissKeyboard: android.dismissKeyboard,
      readLogs: android.readLogs,
      forceStopApp: android.forceStopApp,
      deviceAdbInvocation: android.deviceAdbInvocation,
      hostAdbInvocation: android.hostAdbInvocation,
      adbError: async (message, result, invocation) =>
        android.adbError(message, result, invocation),
    },
    host: {
      runAdb: android.runAdb,
      downloadFile: async (options) => {
        const { downloadLimrunFile } = await import('./download-file.ts');
        await downloadLimrunFile(options);
      },
    },
    ios: {
      createAppLogReader: (input) =>
        createLimrunIosAppLogReader(input, async () => (await loadApple()).tools.parsePlist),
      createRunner: async (session) => {
        const { createLimrunIosRunner } = await import('./ios-runner.ts');
        return await createLimrunIosRunner(session, await loadIosHost());
      },
      readBundleAppName: async (appPath) => await (await loadApple()).readBundleAppName(appPath),
    },
  };
}

/** The capabilities the daemon and `startAgentDevice` add to a `setup` host; refuses a host without them. */
function requireHostCapabilities(host: DeviceProviderPluginHost): ProviderHostCapabilities {
  const { stateDir, emitDiagnostic, loadAndroid, loadApple, loadHostKit } = host;
  if (stateDir !== undefined && emitDiagnostic && loadAndroid && loadApple && loadHostKit)
    return { stateDir, emitDiagnostic, loadAndroid, loadApple, loadHostKit };
  throw host.createError(
    'UNSUPPORTED_OPERATION',
    'This agent-device host does not provide the device capabilities Limrun needs.',
    {
      reason: LIMRUN_HOST_REASONS.capabilityMissing,
      hint: 'Run Limrun through the agent-device daemon or startAgentDevice of a matching release.',
    },
  );
}
