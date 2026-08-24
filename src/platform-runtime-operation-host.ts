import type {
  AppLogSessionArtifacts,
  DeviceShutdownRuntimeLoaders,
  HostCommandRequest,
  OwnedProcessRecordWriter,
  PlatformRuntimeHost,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAppleToolHost } from './platform-runtime-apple-tool-host.ts';
import { createHostToolchainPreparer } from './platform-runtime-toolchain-host.ts';
import { runCmd, whichCmd } from './utils/exec.ts';
import { openAppLogOutput, readAppLogOutputTail } from './platform-runtime-app-log-output.ts';
import { createManagedAppLogProcesses } from './platform-runtime-app-log-process.ts';
import { createNetworkRuntimeHost } from './platform-runtime-network-host.ts';
import { createScreenRecordingRuntimeHost } from './platform-runtime-screen-recording-host.ts';
import { createApplePhysicalReadinessHost } from './platform-runtime-apple-physical-readiness.ts';
import { createAppleAutomationKeepHotHost } from './platform-runtime-apple-automation-keep-hot.ts';
import { createAndroidEmulatorHost } from './platform-runtime-android-emulator-host.ts';
import { createAppInventoryRuntimeHost } from './platform-runtime-app-inventory-host.ts';
import { createAppStateRuntimeHost } from './platform-runtime-app-state-host.ts';
import { createDeviceShutdownRuntimeHost } from './platform-runtime-device-shutdown-host.ts';
import { createAppleAppDeploymentExecutor } from './platform-runtime-apple-deployment-executor.ts';
import { createAndroidAppDeploymentExecutor } from './platform-runtime-android-deployment-executor.ts';
import { createTemporaryTextFile } from './platform-runtime-host.ts';
import { createAndroidToolHost } from './platform-runtime-android-tool-host.ts';
import { createAppleApplicationTools } from './platform-runtime-apple-application-tools.ts';
import { createAndroidApplicationTools } from './platform-runtime-android-application-tools.ts';
import { createLocalApplicationInteractorHost } from './platform-runtime-local-application-interactors.ts';
import { createApplicationResourceLifecycle } from './platform-runtime-application-resources.ts';
import { createSnapshotRuntimeHost } from './snapshot/snapshot-desktop-surface.ts';

export function createPlatformRuntimeHost(options: {
  sessionsDir: string;
  resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
  shutdownLoaders: DeviceShutdownRuntimeLoaders;
  ownedProcesses?: OwnedProcessRecordWriter;
}): PlatformRuntimeHost {
  const processes = createManagedAppLogProcesses(options.sessionsDir);
  const localProcessTransport = Object.freeze({ mode: 'local' as const, start: processes.start });
  const appleTools = createAppleToolHost();
  const commands = Object.freeze({
    which: async (executable: string) => ((await whichCmd(executable)) ? executable : undefined),
    run: async (request: HostCommandRequest, signal?: AbortSignal) => {
      const result = await runCmd(request.executable, [...request.args], {
        allowFailure: request.allowFailure,
        cwd: request.cwd,
        env: request.env ? { ...process.env, ...request.env } : undefined,
        signal,
        timeoutMs: request.timeoutMs,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  });
  const network = createNetworkRuntimeHost({
    resolveSessionArtifacts: options.resolveSessionArtifacts,
    processes,
    resolveTransport: async (device) => {
      if (device.platform !== 'web') return Object.freeze({ mode: 'local' as const });
      const { resolveWebNetworkTransport } =
        await import('./platform-runtime-network-web-transport.ts');
      return await resolveWebNetworkTransport(device);
    },
  });
  const appleApplications = createAppleApplicationTools();
  const androidApplications = createAndroidApplicationTools();
  return Object.freeze({
    commands,
    appleTools,
    toolchains: createHostToolchainPreparer(),
    artifacts: Object.freeze({ resolveSession: options.resolveSessionArtifacts }),
    outputs: Object.freeze({
      openAppend: async (pathname: string) => await openAppLogOutput(options.sessionsDir, pathname),
      readTail: async (pathname: string, maxBytes: number) =>
        await readAppLogOutputTail(options.sessionsDir, pathname, maxBytes),
    }),
    processes,
    processTransports: Object.freeze({
      resolve: async (device: DeviceInfo) => {
        if (device.platform !== 'android') return localProcessTransport;
        const { resolveAndroidAppLogProcessTransport } =
          await import('./platform-runtime-app-log-android-transport.ts');
        return resolveAndroidAppLogProcessTransport(
          options.sessionsDir,
          device,
          localProcessTransport,
        );
      },
    }),
    ...network,
    appInventory: createAppInventoryRuntimeHost(),
    appState: createAppStateRuntimeHost(),
    appleDeployment: createAppleAppDeploymentExecutor(),
    androidDeployment: createAndroidAppDeploymentExecutor(),
    androidTools: createAndroidToolHost(),
    temporaryFiles: Object.freeze({
      create: async (temporaryFileOptions: { prefix: string; suffix: string }) =>
        await createTemporaryTextFile(temporaryFileOptions),
    }),
    deviceReadiness: Object.freeze({
      applePhysical: createApplePhysicalReadinessHost(),
      appleAutomation: createAppleAutomationKeepHotHost(),
      androidEmulator: createAndroidEmulatorHost(),
    }),
    deviceShutdown: createDeviceShutdownRuntimeHost(
      { appleTools, commands },
      options.shutdownLoaders,
    ),
    screenRecording: createScreenRecordingRuntimeHost({ ownedProcesses: options.ownedProcesses }),
    snapshot: createSnapshotRuntimeHost(),
    localInteractors: createLocalApplicationInteractorHost(),
    appleApplications,
    androidApplications,
    applicationResources: createApplicationResourceLifecycle({
      android: androidApplications,
      apple: appleApplications,
    }),
    clock: Object.freeze({
      now: () => Date.now(),
      sleep: async (milliseconds: number, signal?: AbortSignal) => {
        await sleep(milliseconds, undefined, signal ? { signal } : undefined);
      },
    }),
  });
}

export { recoverLegacyAppLogMarkersAfterDaemonLock } from './platform-runtime-app-log-process.ts';
