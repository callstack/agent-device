import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';

export const limrunIosDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-a',
  name: 'Limrun iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

export const limrunRuntimeScope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

export function unusedLimrunRuntimeHost(): PlatformRuntimeHost {
  const failOperation = async (): Promise<never> => {
    throw new Error('unused');
  };
  const implementedFacets = {
    artifacts: {
      resolveSession: (sessionId: string) => ({
        outputPath: `/sessions/${sessionId}/app.log`,
        pidPath: `/sessions/${sessionId}/app-log.pid`,
      }),
    },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/session/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' as const }),
    },
    appleDeployment: unusedHostFacet(failOperation),
    androidDeployment: unusedHostFacet(failOperation),
  };
  // Test-only trust boundary: only app logs and deployment are exercised here.
  // An unexpected host facet returns an operation that fails instead of creating
  // a second, incomplete PlatformRuntimeHost fixture.
  return new Proxy(implementedFacets, {
    get: (target, property) =>
      Reflect.has(target, property)
        ? Reflect.get(target, property)
        : unusedHostFacet(failOperation),
  }) as unknown as PlatformRuntimeHost;
}

// Test-only trust boundary: unexpected host operations must fail, while tests can
// override just the operation they exercise by spreading this empty proxy target.
function unusedHostFacet<Facet extends object>(operation: () => Promise<never>): Facet {
  return new Proxy({} as Facet, { get: () => operation });
}
