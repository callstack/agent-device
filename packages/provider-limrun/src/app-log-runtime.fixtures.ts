import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { LimrunPlatformRuntimeOwnerOptions } from './app-log-runtime.ts';

export const limrunIosSimulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-a',
  name: 'Limrun iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

export const limrunScope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

/**
 * One inert owner wiring. Each scenario overrides only the ports it asserts on, so a new required
 * option lands in a single place instead of every construction site.
 */
export function limrunOwnerOptions(
  overrides: Partial<LimrunPlatformRuntimeOwnerOptions> = {},
): LimrunPlatformRuntimeOwnerOptions {
  return {
    host: unusedLimrunHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => true,
    getInteractor: () => undefined,
    openCurrent: async () => undefined,
    reconnect: async () => ({ status: 'missing' }),
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }),
    configurePortReverse: async () => undefined,
    ...overrides,
  };
}

export function unusedLimrunHost(): PlatformRuntimeHost {
  // These scenarios exercise validation and app-log ports only; every other host port is
  // unreachable, so a narrow record beats restating the full platform-runtime host surface.
  return {
    artifacts: {
      resolveSession: (sessionId: string) => ({
        outputPath: `/sessions/${sessionId}/app.log`,
        pidPath: `/sessions/${sessionId}/app-log.pid`,
      }),
    },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/session/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    snapshot: {
      captureSurface: async () => ({
        backend: 'xctest' as const,
        producer: 'appium-source' as const,
        nodes: [],
      }),
      presentIosAcquisition: async () => ({
        backend: 'xctest' as const,
        producer: 'appium-source' as const,
        nodes: [],
      }),
    },
  } as unknown as PlatformRuntimeHost;
}
