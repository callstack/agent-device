import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { Interactor } from '@agent-device/contracts/interaction';
import { hostFixture } from './logs/runtime.fixtures.ts';

export function platformRuntimeHostFixture(): PlatformRuntimeHost {
  return {
    ...hostFixture().host,
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: { resolve: async () => ({ mode: 'local' }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: {
        keepHot: () => {},
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: {
        discover: async () => [],
        launch: () => 1,
        terminate: async () => {},
      },
    },
    localInteractors: { resolve: async () => ({}) as Interactor },
    applicationResources: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => {},
      finalizeDaemonShutdown: async () => {},
    },
    appleApplications: {
      resolveOpenTarget: async () => ({}),
      prewarmRunnerCache: async () => {},
      prewarmRunnerSession: async () => {},
      notifyRunnerAppRelaunched: async () => {},
      stopRunnerSession: async () => {},
      scheduleRunnerIdleStop: () => {},
      prepareRunner: async () => ({ runner: {}, connectMs: 0, healthCheckMs: 0 }),
      applyRuntimeHints: async () => {},
      clearRuntimeHints: async () => {},
      dismissCloseAlerts: async () => {},
      shutdownTarget: async () => undefined,
      detachRunnerSessionsForShutdown: async () => {},
      finalizeRunnerSessionsForShutdown: async () => {},
    },
    androidApplications: {} as PlatformRuntimeHost['androidApplications'],
    screenRecording: {
      apple: {
        availability: async () => ({ available: true }),
        runRunner: async () => ({}),
        startSimulator: async () => {
          throw new Error('unused');
        },
        inspectProcess: async () => 'missing',
        terminateProcess: async () => 'already-missing',
        inspectRunner: async () => 'missing',
        retrieveRunnerRecording: async () => {},
        captureClockAnchor: async () => undefined,
        isRunnerBundleId: async () => false,
      },
      android: {
        resolve: async () => {
          throw new Error('unused');
        },
      },
      harmony: {
        start: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        stop: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        findMedia: async () => undefined,
        stageMedia: async () => false,
        stagedFileSize: async () => undefined,
        pull: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        remove: async () => true,
        removeMedia: async () => true,
      },
      web: { resolve: async () => undefined },
      outputs: { prepare: async () => {} },
      finalize: { complete: async () => ({}) },
      ownedProcesses: { replace: () => {}, clear: () => {} },
    },
  } as unknown as PlatformRuntimeHost;
}
