import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime } from '@agent-device/provider-limrun';
import { limrunTestDependencies } from '../../../src/platform-runtime-gateway.fixtures.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';

/**
 * The live capture route through the daemon's real request path: `network start` opens the
 * instance's destination tunnel with inspection, `network dump` answers from that source, and
 * `network stop` hands the dump back to the app-log source. The tunnel client is the seam; the
 * capture, seam, session, and CLI answer for real.
 */

const limrunState = vi.hoisted(() => ({
  startTunnel: vi.fn(),
  closed: 0,
  emit: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: vi.fn(async () => ({
        metadata: { id: 'limrun-capture-test-instance' },
        status: { apiUrl: 'https://limrun.example', token: 'limrun-test-token' },
      })),
      list: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    readonly androidInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };
    readonly assets = { getOrUpload: vi.fn(), list: vi.fn() };
  },
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    deviceInfo: { screenWidth: 402, screenHeight: 874, model: 'iPhone' },
    disconnect: vi.fn(),
    keepAlive: vi.fn(),
    listApps: vi.fn(async () => [{ bundleId: 'com.example.demo', name: 'Demo' }]),
    launchApp: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    startTunnel: limrunState.startTunnel,
  })),
}));

test('network start captures through the tunnel, the dump reads that source, and stop hands back', async () => {
  let closedTunnels = 0;
  limrunState.startTunnel.mockImplementation(
    async (options: { onInspectionEvent?: (event: unknown) => void }) => {
      limrunState.emit = options.onInspectionEvent;
      return {
        close: () => {
          closedTunnels += 1;
        },
      };
    },
  );
  const registration = createLimrunRuntime(
    { apiKey: 'limrun-test-key' },
    { ...limrunTestDependencies },
    { includePlatformModule: true },
  );
  const providers = createProviderDeviceRuntimeRequestProviders([registration.runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventorySource: providers.deviceInventorySource!,
    platformRuntime: {
      providerRuntimes: [registration.runtime],
      providerModules: [{ runtime: registration.runtime, module: registration.platformModule }],
    },
  });

  try {
    const lease = await allocateLease(daemon);
    const open = await daemon.callCommand(
      'open',
      ['com.example.demo'],
      {
        platform: 'ios',
        tenant: 'team-a',
        runId: 'run-a',
        leaseId: lease.leaseId,
        leaseProvider: 'limrun',
      },
      { meta: leaseMeta(lease.leaseId) },
    );
    assertRpcOk(open);

    const startRaw = await daemon.callCommand('network', ['start'], {
      networkHosts: ['api.example.com'],
    });
    const start = assertRpcOk<{
      started?: boolean;
      source?: string;
      hosts?: string[];
      requiresRelaunch?: boolean;
      capturingBodies?: boolean;
    }>(startRaw);
    assert.equal(start.started, true);
    assert.equal(start.source, 'limrun-tunnel');
    assert.deepEqual(start.hosts, ['api.example.com']);
    // The app was opened before capture started, so its existing sockets are outside the window.
    assert.equal(start.requiresRelaunch, true);
    assert.equal(start.capturingBodies, true);
    assert.equal(limrunState.startTunnel.mock.calls.length, 1);
    const [tunnelOptions] = limrunState.startTunnel.mock.calls[0] as [
      { selectors: string[]; inspection?: Record<string, unknown> },
    ];
    assert.deepEqual(tunnelOptions.selectors, ['api.example.com']);
    assert.deepEqual(tunnelOptions.inspection, {
      enabled: true,
      captureBodies: true,
      maxBodyBytes: 2 * 1024 * 1024,
    });

    limrunState.emit?.(harCompleteEvent('https://api.example.com/v1/orders?token=secret'));

    const dump = assertRpcOk<{
      source?: string;
      backend?: string;
      entries?: Array<{ method?: string; url?: string }>;
    }>(await daemon.callCommand('network', ['dump', '5']));
    assert.equal(dump.source, 'provider');
    assert.equal(dump.backend, 'limrun-tunnel');
    assert.equal(dump.entries?.length, 1);
    assert.equal(dump.entries?.[0]?.method, 'GET');
    // Query strings cross the redaction boundary, so the capture never replays a URL's secrets.
    assert.equal(dump.entries?.[0]?.url, 'https://api.example.com/v1/orders?REDACTED');

    const stop = assertRpcOk<{ stopped?: boolean }>(await daemon.callCommand('network', ['stop']));
    assert.equal(stop.stopped, true);
    assert.equal(closedTunnels, 1);

    // With the capture stopped, the dump falls back to the session's app-log source and names it.
    const afterStop = assertRpcOk<{ source?: string }>(
      await daemon.callCommand('network', ['dump', '5']),
    );
    assert.equal(afterStop.source, 'app-log');
  } finally {
    await daemon.close();
    await registration.runtime.shutdown();
  }
}, 30_000);

async function allocateLease(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
): Promise<DeviceLease> {
  const response = await daemon.callCommand(
    'lease_allocate',
    [],
    { platform: 'ios', tenant: 'team-a', runId: 'run-a', leaseProvider: 'limrun' },
    {
      meta: {
        tenantId: 'team-a',
        runId: 'run-a',
        leaseBackend: 'ios-instance',
        leaseProvider: 'limrun',
        deviceKey: 'ios-a',
        clientId: 'client-a',
      },
    },
  );
  return assertRpcOk<{ lease: DeviceLease }>(response).lease;
}

function leaseMeta(leaseId: string) {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'ios-instance' as const,
    leaseProvider: 'limrun' as const,
    deviceKey: 'ios-a',
    clientId: 'client-a',
  };
}

function harCompleteEvent(url: string): unknown {
  return {
    type: 'complete',
    sequence: 1,
    requestId: 'r1',
    data: {
      startedDateTime: '2026-10-24T10:00:00.000Z',
      time: 42,
      request: {
        method: 'GET',
        url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [{ name: 'accept', value: 'application/json' }],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [{ name: 'content-type', value: 'application/json' }],
        content: { size: 2, mimeType: 'application/json', text: '{"ok":true}' },
        redirectURL: '',
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 1, wait: 40, receive: 1 },
      _limrun: {
        tunnelId: 'tun_1',
        selectorId: 'sel_1',
        requestBodyTruncated: false,
        responseBodyTruncated: false,
      },
    },
  };
}
