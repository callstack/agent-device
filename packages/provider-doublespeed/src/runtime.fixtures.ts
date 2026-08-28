import type { DeviceLease } from '@agent-device/contracts/device';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DoublespeedPlatformRuntimeOwnerOptions } from './app-log-runtime.ts';
import type { DoublespeedRuntimeDependencies } from './runtime-dependencies.ts';

export const doublespeedIosDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'doublespeed:ios:lease-a',
  name: 'Doublespeed iPhone 16',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

export const doublespeedScope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

export function doublespeedLease(leaseId = 'lease-a'): DeviceLease {
  return {
    leaseId,
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'doublespeed',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

export const doublespeedTestDependencies: DoublespeedRuntimeDependencies = {
  clientVersion: 'test-version',
  host: { archiveDirectory: async () => undefined },
  ios: {
    resolveAppAlias: async (app) => app,
    readBundleAppName: async () => undefined,
  },
};

/**
 * One inert owner wiring. Each scenario overrides only the ports it asserts on, so a new required
 * option lands in a single place instead of every construction site.
 */
export function doublespeedOwnerOptions(
  overrides: Partial<DoublespeedPlatformRuntimeOwnerOptions> = {},
): DoublespeedPlatformRuntimeOwnerOptions {
  return {
    host: unusedDoublespeedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    hasLiveSession: () => true,
    getInteractor: () => undefined,
    openCurrent: async () => undefined,
    reconnect: async () => ({ status: 'missing' }),
    listApps: async () => [],
    getAppState: async () => ({ package: 'com.example.app' }),
    ...overrides,
  };
}

export function unusedDoublespeedHost(): PlatformRuntimeHost {
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
      readProcessMarker: async () => ({ status: 'missing' as const }),
    },
    appleDeployment: unusedHostFacet(failOperation),
    androidDeployment: unusedHostFacet(failOperation),
  };
  // Test-only trust boundary: an unexpected host facet returns an operation that fails instead
  // of creating a second, incomplete PlatformRuntimeHost fixture.
  return new Proxy(implementedFacets, {
    get: (target, property) =>
      Reflect.has(target, property)
        ? Reflect.get(target, property)
        : unusedHostFacet(failOperation),
  }) as unknown as PlatformRuntimeHost;
}

function unusedHostFacet<Facet extends object>(operation: () => Promise<never>): Facet {
  return new Proxy({} as Facet, { get: () => operation });
}

export type FetchCall = { url: string; init: RequestInit };

/** A scripted `fetch`: each handler answers one request in order and records what it saw. */
export function scriptedFetch(
  handlers: Array<(call: FetchCall) => { status?: number; body?: unknown }>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected request ${call.init.method ?? 'GET'} ${call.url}`);
    const { status = 200, body = {} } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function readySimulator(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sim-a',
    status: 'running',
    ready: true,
    device: 'iPhone 16',
    labels: { provider: 'doublespeed', leaseId: 'lease-a' },
    api_url: 'https://worker.example/i/token-a',
    token: 'token-a',
    viewer_url: 'https://worker.example/s/token-a',
    screen: { width: 393, height: 852, scale: 3 },
    expires_at: '2030-01-01T00:00:00.000Z',
    error: null,
    ...overrides,
  };
}
