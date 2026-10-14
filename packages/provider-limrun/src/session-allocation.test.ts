import Limrun from '@limrun/api';
import { expect, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';
import { allocateLimrunAndroidSession, allocateLimrunIosSession } from './session-allocation.ts';

vi.mock('./android.ts', () => ({ createLimrunAndroidSession: vi.fn() }));
vi.mock('./ios.ts', () => ({ createLimrunIosSession: vi.fn() }));

test.for([
  { platform: 'ios', allocate: allocateLimrunIosSession, backend: 'ios-instance' },
  { platform: 'android', allocate: allocateLimrunAndroidSession, backend: 'android-instance' },
] as const)(
  '$platform creation sends partner attribution in User-Agent only on creation',
  async ({ platform, allocate, backend }) => {
    const requests: Array<{ method: string; headers: Headers; url: string }> = [];
    let instanceReady = true;
    const limrun = new Limrun({
      apiKey: 'lim_test_key',
      baseURL: 'https://limrun.example',
      maxRetries: 0,
      fetch: async (url, init) => {
        requests.push({
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(
          JSON.stringify({
            metadata: { id: 'instance-1' },
            status: {
              token: 'instance-token',
              ...(instanceReady
                ? {
                    apiUrl: 'https://instance.example',
                    adbWebSocketUrl: 'wss://adb.example',
                  }
                : {}),
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const lease: DeviceLease = {
      leaseId: 'lease-attribution',
      tenantId: 'team-a',
      runId: 'run-a',
      backend,
      leaseProvider: 'limrun',
      createdAt: 1,
      heartbeatAt: 1,
      expiresAt: 60_001,
    };

    const params = {
      limrun,
      lease,
      metadata: { displayName: 'Attribution test', labels: {} },
      // Session construction is mocked; allocation only consumes the client version.
      dependencies: { clientVersion: '1.2.3' } as LimrunRuntimeDependencies,
    };
    await allocate(params);
    await limrun[platform === 'ios' ? 'iosInstances' : 'androidInstances'].delete('instance-1');

    instanceReady = false;
    await expect(allocate(params)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

    expect(requests.map(({ method }) => method)).toEqual(['POST', 'DELETE', 'POST', 'DELETE']);
    for (const request of [requests[0]!, requests[2]!]) {
      expect(new URL(request.url).pathname).toBe(`/v1/${platform}_instances`);
      expect(request.headers.get('user-agent')).toBe('agent-device-cli/1.2.3');
    }
    for (const request of [requests[1]!, requests[3]!]) {
      expect(new URL(request.url).pathname).toBe(`/v1/${platform}_instances/instance-1`);
      expect(request.headers.get('user-agent')).toMatch(/^Limrun\/JS /);
    }
    for (const request of requests) {
      expect(request.headers.has('x-agent-device-client')).toBe(false);
      expect(request.headers.has('x-agent-device-version')).toBe(false);
    }
  },
);
