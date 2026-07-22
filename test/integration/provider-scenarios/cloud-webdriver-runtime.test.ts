import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { test } from 'vitest';
import { createCloudWebDriverRuntime } from '../../../src/cloud-webdriver/runtime.ts';
import { createDefaultCloudWebDriverProviderRuntimes } from '../../../src/cloud-webdriver/provider-runtimes.ts';
import { scrollFrameFromWebDriverSource } from '../../../src/cloud-webdriver/webdriver-scroll-frame.ts';
import { parseWebDriverSource } from '../../../src/cloud-webdriver/webdriver-source.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from '../../../src/cloud-webdriver/providers.ts';
import type { CloudArtifact } from '../../../src/cloud-artifacts.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { createExpiredProviderLeaseReleaser } from '../../../src/daemon/provider-lease-expiry.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';
import { runProviderScenario, type ProviderScenarioStep } from './scenario.ts';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
  writeCloudWebDriverTestJson,
} from './cloud-webdriver-test-server.ts';

const WEBDRIVER_PROVIDER = 'webdriver-fake';

test('Cloud WebDriver runtime drives provider devices through daemon commands', async () => {
  await withProviderScenarioResource(createCloudWebDriverWorld, async (world) => {
    const { daemon, server } = world;
    await withProviderScenarioTempDir('agent-device-cloud-webdriver-', async (tempDir) => {
      const appPath = path.join(tempDir, 'demo.apk');
      fs.writeFileSync(appPath, 'fake apk');
      const lease = await allocateWebDriverLease(daemon);
      const steps = cloudWebDriverScenarioSteps(appPath, lease);
      const releaseStep = steps.at(-1);
      assert.ok(releaseStep);
      await runProviderScenario(daemon, steps.slice(0, -1), {
        flags: leaseFlags(lease.leaseId),
        meta: leaseMeta(lease.leaseId),
      });
      const inferredArtifacts = await daemon.callCommand('artifacts');
      const inferredData = assertRpcOk<{
        provider?: string;
        status?: string;
        providerSessionId?: string;
      }>(inferredArtifacts);
      assert.equal(inferredData.provider, WEBDRIVER_PROVIDER);
      assert.equal(inferredData.status, 'ready');
      assert.equal(inferredData.providerSessionId, 'wd-1');

      world.failNextArtifactLookup();
      const unavailableArtifacts = await daemon.callCommand('artifacts');
      const unavailableData = assertRpcOk<{
        provider?: string;
        status?: string;
        providerSessionId?: string;
        cloudArtifacts?: CloudArtifact[];
      }>(unavailableArtifacts);
      assert.equal(unavailableData.provider, WEBDRIVER_PROVIDER);
      assert.equal(unavailableData.status, 'unavailable');
      assert.equal(unavailableData.providerSessionId, 'wd-1');
      assert.deepEqual(unavailableData.cloudArtifacts, []);

      await runProviderScenario(daemon, [releaseStep], {
        flags: leaseFlags(lease.leaseId),
        meta: leaseMeta(lease.leaseId),
      });
      assertWebDriverCalls(server.calls, lease.leaseId, appPath);
    });
  });
}, 15_000);

test('Cloud WebDriver release still returns artifacts when WebDriver session delete fails', async () => {
  await withProviderScenarioResource(createCloudWebDriverWorld, async (world) => {
    const { daemon, server } = world;
    const lease = await allocateWebDriverLease(daemon);
    server.sessionDeleteFailuresRemaining = 2;

    const release = await daemon.callCommand('lease_release', [], leaseFlags(lease.leaseId), {
      meta: leaseMeta(lease.leaseId),
    });

    const data = assertRpcOk<{
      released?: boolean;
      provider?: {
        provider?: string;
        providerSessionId?: string;
        warnings?: Array<{ code?: string; message?: string }>;
        cloudArtifacts?: {
          status?: string;
          cloudArtifacts?: Array<{ kind?: string }>;
        };
      };
    }>(release);
    assert.equal(data.released, true);
    assert.equal(data.provider?.provider, WEBDRIVER_PROVIDER);
    assert.equal(data.provider?.providerSessionId, 'wd-1');
    assert.equal(data.provider?.warnings?.[0]?.code, 'WEBDRIVER_SESSION_DELETE_FAILED');
    assert.match(data.provider?.warnings?.[0]?.message ?? '', /stale webdriver session/);
    assert.equal(data.provider?.cloudArtifacts?.status, 'ready');
    assert.equal(data.provider?.cloudArtifacts?.cloudArtifacts?.[0]?.kind, 'video');
  });
}, 15_000);

test('Cloud WebDriver expiry releases the live provider session', async () => {
  await withProviderScenarioResource(createCloudWebDriverWorld, async (world) => {
    const lease = await allocateWebDriverLease(world.daemon);
    const releaser = createExpiredProviderLeaseReleaser({
      leaseLifecycleProvider: world.providers.leaseLifecycleProvider,
      providerRuntimeIds: world.providers.providerRuntimeIds,
      recoverableProviderIds: world.providers.recoverableProviderIds,
    });

    try {
      await releaser.release(lease);
      assert.equal(
        world.server.calls.some(
          (call) => call.method === 'DELETE' && call.path === '/wd/hub/session/wd-1',
        ),
        true,
      );
    } finally {
      releaser.shutdown();
    }
  });
}, 15_000);

test('Cloud WebDriver allocation preserves create-session failure when cleanup fails', async () => {
  let cleanupCalled = false;
  await withProviderScenarioResource(
    () =>
      createCloudWebDriverWorld({
        cleanup: async () => {
          cleanupCalled = true;
          throw new Error('provider cleanup failed');
        },
      }),
    async (world) => {
      const { daemon, server } = world;
      server.createSessionFailuresRemaining = 2;

      const allocate = await daemon.callCommand('lease_allocate', [], leaseFlags(), {
        meta: leaseMeta(),
      });

      const error = assertRpcError(allocate, 'COMMAND_FAILED', /create session failed/) as {
        details?: { cleanupError?: unknown };
      };
      assert.equal(error.details?.cleanupError, 'provider cleanup failed');
      assert.equal(cleanupCalled, true);
    },
  );
}, 15_000);

test('default BrowserStack provider runtime builds sessions from daemon request profile flags', async () => {
  const server = await FakeWebDriverServer.start();
  const runtimes = createDefaultCloudWebDriverProviderRuntimes({
    BROWSERSTACK_USERNAME: 'browser-user',
    BROWSERSTACK_ACCESS_KEY: 'browser-key',
    BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
  });
  const providers = createProviderDeviceRuntimeRequestProviders(runtimes);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventoryProvider: providers.deviceInventoryProvider!,
  });
  try {
    const allocate = await daemon.callCommand(
      'lease_allocate',
      [],
      {
        tenant: 'team-a',
        runId: 'run-a',
        platform: 'android',
        device: 'Google Pixel 8',
        providerApp: 'bs://app-id',
        providerOsVersion: '14.0',
        providerProject: 'agent-device',
        providerBuild: 'build-a',
        providerSessionName: 'session-a',
      },
      {
        meta: {
          tenantId: 'team-a',
          runId: 'run-a',
          leaseBackend: 'android-instance',
          leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
          clientId: 'client-a',
        },
      },
    );
    const data = assertRpcOk<{
      lease?: DeviceLease;
      provider?: {
        provider?: string;
        sessionId?: string;
        providerSessionId?: string;
      };
    }>(allocate);
    assert.equal(data.provider?.provider, CLOUD_WEBDRIVER_PROVIDERS.browserStack);
    assert.equal(data.provider?.providerSessionId, 'wd-1');
    assert.deepEqual(server.calls[0]?.body, {
      capabilities: {
        alwaysMatch: {
          platformName: 'Android',
          'appium:deviceName': 'Google Pixel 8',
          device: 'Google Pixel 8',
          os_version: '14.0',
          app: 'bs://app-id',
          'bstack:options': {
            projectName: 'agent-device',
            buildName: 'build-a',
            sessionName: 'session-a',
          },
        },
      },
    });
    assert.equal(
      server.calls[0]?.headers.authorization,
      `Basic ${Buffer.from('browser-user:browser-key').toString('base64')}`,
    );
  } finally {
    await daemon.close();
    await Promise.allSettled(runtimes.map(async (runtime) => await runtime.shutdown()));
    await server.close();
  }
}, 15_000);

test('WebDriver source parser reuses hardened XML parsing', () => {
  const nodes = parseWebDriverSource(
    '<hierarchy><node text="A &gt; B" resource-id="login" bounds="[0,0][10,10]" displayed="true" /></hierarchy>',
  );

  assert.equal(nodes[0]?.label, 'A > B');
  assert.equal(nodes[0]?.identifier, 'login');
  assert.deepEqual(nodes[0]?.rect, { x: 0, y: 0, width: 10, height: 10 });
  assert.throws(
    () => parseWebDriverSource('<node __proto__="polluted" text="x" />'),
    /Unsupported XML attribute name "__proto__"/,
  );
});

test('WebDriver scroll frame prefers visible scrollable containers', () => {
  assert.deepEqual(
    scrollFrameFromWebDriverSource(
      '<hierarchy>' +
        '<android.widget.FrameLayout bounds="[0,0][1080,2400]" displayed="true" />' +
        '<android.widget.ListView bounds="[0,393][1080,1496]" displayed="true" />' +
        '<android.support.v7.widget.RecyclerView bounds="[18,597][1062,1196]" displayed="false" />' +
        '</hierarchy>',
    ),
    { x: 0, y: 393, width: 1080, height: 1103 },
  );
});

async function createCloudWebDriverWorld(
  options: { cleanup?: () => Promise<Record<string, unknown> | undefined> } = {},
) {
  const server = await FakeWebDriverServer.start();
  let artifactFailuresRemaining = 0;
  const runtime = createCloudWebDriverRuntime({
    provider: WEBDRIVER_PROVIDER,
    endpoint: `${server.url}/wd/hub/`,
    platform: 'android',
    deviceName: 'BrowserStack Google Pixel 8',
    webdriverCapabilities: (lease) => ({
      'appium:automationName': 'UiAutomator2',
      'bstack:options': {
        buildName: lease.runId,
        sessionName: lease.leaseId,
      },
    }),
    prepareSession: options.cleanup
      ? async ({ base }) => ({ ...base, cleanup: options.cleanup })
      : undefined,
    listArtifacts: async ({ provider, providerSessionId }) => {
      if (artifactFailuresRemaining > 0) {
        artifactFailuresRemaining -= 1;
        throw new Error('provider artifact lookup failed');
      }
      return {
        provider,
        providerSessionId,
        status: 'ready',
        cloudArtifacts: [
          {
            provider,
            providerSessionId,
            kind: 'video',
            name: 'Session video',
            url: 'https://provider.example/video.mp4',
            availability: 'ready',
          },
        ],
      };
    },
  });
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventoryProvider: providers.deviceInventoryProvider!,
  });
  return {
    daemon,
    server,
    providers,
    failNextArtifactLookup: () => {
      artifactFailuresRemaining += 1;
    },
    close: async () => {
      await runtime.shutdown();
      await daemon.close();
      await server.close();
    },
  };
}

async function allocateWebDriverLease(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
): Promise<DeviceLease> {
  const allocate = await daemon.callCommand('lease_allocate', [], leaseFlags(), {
    meta: leaseMeta(),
  });
  const data = assertRpcOk<{
    lease: DeviceLease;
    provider?: {
      capabilities?: { operations?: { snapshot?: { support?: string } } };
    };
  }>(allocate);
  assert.equal(data.provider?.capabilities?.operations?.snapshot?.support, 'partial');
  return data.lease;
}

function cloudWebDriverScenarioSteps(appPath: string, lease: DeviceLease): ProviderScenarioStep[] {
  return [
    {
      name: 'heartbeat',
      command: 'lease_heartbeat',
      expectData: { provider: { provider: WEBDRIVER_PROVIDER } },
    },
    {
      name: 'install',
      command: 'install',
      positionals: ['com.example.demo', appPath],
      expectData: {
        platform: 'android',
        packageName: 'com.example.demo',
      },
    },
    {
      name: 'open',
      command: 'open',
      positionals: ['com.example.demo'],
      expectData: {
        platform: 'android',
        id: `webdriver-fake:android:${lease.leaseId}`,
        serial: `webdriver-fake:android:${lease.leaseId}`,
      },
    },
    { name: 'click', command: 'click', positionals: ['10', '20'], expectData: { x: 10, y: 20 } },
    {
      name: 'fill',
      command: 'fill',
      positionals: ['12', '24', 'hello cloud'],
      expectData: { x: 12, y: 24, text: 'hello cloud' },
    },
    {
      name: 'snapshot',
      command: 'snapshot',
      assert: (response) => {
        const data = assertRpcOk<{
          nodes?: Array<{
            label?: string;
            identifier?: string;
            depth?: number;
            parentIndex?: number;
            hittable?: boolean;
          }>;
        }>(response);
        assert.equal(data.nodes?.[1]?.label, 'Login');
        assert.equal(data.nodes?.[1]?.identifier, 'com.example:id/login');
        assert.equal(data.nodes?.[1]?.depth, 1);
        assert.equal(data.nodes?.[1]?.parentIndex, 0);
        assert.equal(data.nodes?.[1]?.hittable, true);
      },
    },
    {
      name: 'scroll',
      command: 'scroll',
      positionals: ['down'],
      flags: { pixels: 200 },
      expectData: { direction: 'down', distance: 200 },
    },
    {
      name: 'artifacts',
      command: 'artifacts',
      expectData: {
        provider: WEBDRIVER_PROVIDER,
        status: 'ready',
        providerSessionId: 'wd-1',
      },
    },
    {
      name: 'release',
      command: 'lease_release',
      assert: (response) => {
        const data = assertRpcOk<{
          released?: boolean;
          provider?: {
            provider?: string;
            providerSessionId?: string;
            cloudArtifacts?: {
              status?: string;
              cloudArtifacts?: Array<{ kind?: string }>;
            };
          };
        }>(response);
        assert.equal(data.released, true);
        assert.equal(data.provider?.provider, WEBDRIVER_PROVIDER);
        assert.equal(data.provider?.providerSessionId, 'wd-1');
        assert.equal(data.provider?.cloudArtifacts?.status, 'ready');
        assert.equal(data.provider?.cloudArtifacts?.cloudArtifacts?.[0]?.kind, 'video');
      },
    },
  ];
}

function assertWebDriverCalls(
  calls: readonly CloudWebDriverHttpCall[],
  leaseId: string,
  appPath: string,
): void {
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'POST /wd/hub/session',
      'POST /wd/hub/session/wd-1/appium/device/install_app',
      'POST /wd/hub/session/wd-1/appium/device/activate_app',
      'POST /wd/hub/session/wd-1/actions',
      'DELETE /wd/hub/session/wd-1/actions',
      'POST /wd/hub/session/wd-1/actions',
      'DELETE /wd/hub/session/wd-1/actions',
      'POST /wd/hub/session/wd-1/keys',
      'GET /wd/hub/session/wd-1/source',
      'POST /wd/hub/session/wd-1/appium/device/hide_keyboard',
      'GET /wd/hub/session/wd-1/source',
      'POST /wd/hub/session/wd-1/actions',
      'DELETE /wd/hub/session/wd-1/actions',
      'DELETE /wd/hub/session/wd-1',
    ],
  );
  assert.deepEqual(calls[0]?.body, {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:deviceName': 'BrowserStack Google Pixel 8',
        'appium:automationName': 'UiAutomator2',
        'bstack:options': {
          buildName: 'run-a',
          sessionName: leaseId,
        },
      },
    },
  });
  assert.deepEqual(calls[1]?.body, { appPath });
  assert.deepEqual(calls[2]?.body, { appId: 'com.example.demo' });
  assert.deepEqual(calls[7]?.body, { value: Array.from('hello cloud') });
  assert.equal(calls[9]?.body, undefined);
  assert.deepEqual(calls[11]?.body, {
    actions: [
      {
        type: 'pointer',
        id: 'swipe',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: 540, y: 988 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 350, x: 540, y: 788 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
  for (const call of calls) {
    assert.equal(call.headers['x-agent-device-client'], 'agent-device-cli');
    assert.equal(typeof call.headers['x-agent-device-version'], 'string');
    assert.notEqual(call.headers['x-agent-device-version'], '');
  }
}

class FakeWebDriverServer extends CloudWebDriverTestServer {
  createSessionFailuresRemaining = 0;
  sessionDeleteFailuresRemaining = 0;

  static async start(): Promise<StartedCloudWebDriverTestServer<FakeWebDriverServer>> {
    return await startCloudWebDriverTestServer(new FakeWebDriverServer());
  }

  protected respond(call: CloudWebDriverHttpCall, res: ServerResponse): void {
    respondToFakeWebDriverCall(this, call, res);
  }
}

function respondToFakeWebDriverCall(
  server: FakeWebDriverServer,
  call: CloudWebDriverHttpCall,
  res: ServerResponse,
): void {
  switch (`${call.method} ${call.path}`) {
    case 'POST /wd/hub/session':
      writeFakeCreateSessionResponse(server, res);
      return;
    case 'GET /wd/hub/session/wd-1/source':
      writeCloudWebDriverTestJson(res, { value: fakeWebDriverSource() });
      return;
    case 'GET /wd/hub/session/wd-1/window/rect':
      writeCloudWebDriverTestJson(res, { value: { x: 0, y: 0, width: 1080, height: 1920 } });
      return;
    case 'DELETE /wd/hub/session/wd-1/actions':
      writeCloudWebDriverTestJson(
        res,
        { value: { message: 'The requested resource could not be found.' } },
        500,
      );
      return;
    case 'DELETE /wd/hub/session/wd-1':
      writeFakeDeleteSessionResponse(server, res);
      return;
    default:
      writeCloudWebDriverTestJson(res, { value: null });
  }
}

function writeFakeCreateSessionResponse(server: FakeWebDriverServer, res: ServerResponse): void {
  if (server.createSessionFailuresRemaining > 0) {
    server.createSessionFailuresRemaining -= 1;
    writeCloudWebDriverTestJson(res, { value: { message: 'create session failed' } }, 500);
    return;
  }
  writeCloudWebDriverTestJson(res, {
    value: {
      sessionId: 'wd-1',
      capabilities: { platformName: 'Android' },
    },
  });
}

function writeFakeDeleteSessionResponse(server: FakeWebDriverServer, res: ServerResponse): void {
  if (server.sessionDeleteFailuresRemaining > 0) {
    server.sessionDeleteFailuresRemaining -= 1;
    writeCloudWebDriverTestJson(res, { value: { message: 'stale webdriver session' } }, 500);
    return;
  }
  writeCloudWebDriverTestJson(res, { value: null });
}

function fakeWebDriverSource(): string {
  return (
    '<hierarchy><node text="Root" bounds="[0,0][100,40]" displayed="true">' +
    '<node text="Login" resource-id="com.example:id/login" bounds="[10,20][110,70]" displayed="true" />' +
    '<android.widget.ListView resource-id="com.example:id/results" bounds="[0,279][1080,1496]" displayed="true" />' +
    '</node></hierarchy>'
  );
}

function leaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'android',
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: WEBDRIVER_PROVIDER,
  };
}

function leaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'android-instance',
    leaseProvider: WEBDRIVER_PROVIDER,
    deviceKey: 'webdriver-android-a',
    clientId: 'client-a',
  };
}
