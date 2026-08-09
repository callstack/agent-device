import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  createProviderWebDriver,
} from '@agent-device/provider-webdriver';
import type { CloudArtifact } from '@agent-device/contracts/observability';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { createExpiredProviderLeaseReleaser } from '../../../src/daemon/provider-lease-expiry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import { assertRpcOk } from './assertions.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';
import { runProviderScenario, type ProviderScenarioStep } from './scenario.ts';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  type CloudWebDriverTestResponse,
  cloudWebDriverTestJson,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
} from './cloud-webdriver-test-server.ts';

const WEBDRIVER_PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.browserStack;
const CLIENT_VERSION = '0.20.3-test';

test('packaged Cloud WebDriver facade drives provider devices through daemon commands', async () => {
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

      server.artifactFailuresRemaining = 1;
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
      assertWebDriverCalls(server.calls, lease.leaseId);
    });
  });
}, 15_000);

test('packaged Cloud WebDriver release still returns artifacts when session delete fails', async () => {
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

test('packaged Cloud WebDriver orientation rotates through the four-way endpoint', async () => {
  await withProviderScenarioResource(createCloudWebDriverWorld, async (world) => {
    const { daemon, server } = world;
    const lease = await openWebDriverSession(daemon);

    const response = await daemon.callCommand(
      'orientation',
      ['landscape-right'],
      {
        ...leaseFlags(lease.leaseId),
      },
      { meta: leaseMeta(lease.leaseId) },
    );
    const data = assertRpcOk<{ action?: string; orientation?: string }>(response);
    assert.equal(data.action, 'orientation');
    assert.equal(data.orientation, 'landscape-right');

    const rotation = rotationCalls(server);
    assert.deepEqual(
      rotation.map((call) => call.body),
      [{ x: 0, y: 0, z: 270 }],
    );
    // The exact four-way endpoint answered, so the two-way one is never consulted.
    assert.equal(orientationCalls(server).length, 0);
  });
}, 15_000);

test('packaged Cloud WebDriver orientation falls back when the driver lacks the rotation route', async () => {
  await withProviderScenarioResource(createCloudWebDriverWorld, async (world) => {
    const { daemon, server } = world;
    const lease = await openWebDriverSession(daemon);
    server.rotationBehavior = 'unsupported';

    const response = await daemon.callCommand(
      'orientation',
      ['portrait'],
      {
        ...leaseFlags(lease.leaseId),
      },
      { meta: leaseMeta(lease.leaseId) },
    );
    assert.equal(assertRpcOk<{ orientation?: string }>(response).orientation, 'portrait');

    assert.equal(rotationCalls(server).length, 1);
    // Four-way intent collapses onto the two-way endpoint's vocabulary.
    assert.deepEqual(
      orientationCalls(server).map((call) => call.body),
      [{ orientation: 'PORTRAIT' }],
    );
  });
}, 15_000);

test('packaged Cloud WebDriver orientation surfaces a provider failure instead of falling back', async () => {
  await withProviderScenarioResource(createCloudWebDriverWorld, async (world) => {
    const { daemon, server } = world;
    const lease = await openWebDriverSession(daemon);
    server.rotationBehavior = 'server-error';

    const response = await daemon.callCommand(
      'orientation',
      ['portrait'],
      {
        ...leaseFlags(lease.leaseId),
      },
      { meta: leaseMeta(lease.leaseId) },
    );
    const error = response.json.error;
    assert.ok(error, 'expected orientation to fail');
    assert.match(error.message ?? '', /provider rotation backend failed/);

    // A driver that implements the route and failed must not be retried against a different one:
    // doing so would report a backend outage as an orientation-support problem.
    assert.equal(orientationCalls(server).length, 0);
  });
}, 15_000);

test('packaged Cloud WebDriver expiry releases the live provider session', async () => {
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

async function createCloudWebDriverWorld() {
  const server = await FakeWebDriverServer.start();
  const providerWebDriver = createProviderWebDriver({
    clientVersion: CLIENT_VERSION,
    runHostCommand: async () => {
      throw new Error('BrowserStack scenario must not run host commands');
    },
  });
  const runtimes = providerWebDriver.createDefaultRuntimes({
    BROWSERSTACK_USERNAME: 'browser-user',
    BROWSERSTACK_ACCESS_KEY: 'browser-key',
    BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
    BROWSERSTACK_APP_UPLOAD_ENDPOINT: `${server.url}/app-automate/upload`,
    BROWSERSTACK_SESSION_DETAILS_ENDPOINT: `${server.url}/app-automate/sessions`,
  });
  const providers = createProviderDeviceRuntimeRequestProviders(runtimes);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventorySource: providers.deviceInventorySource!,
  });
  return {
    daemon,
    server,
    providers,
    close: async () => {
      await Promise.allSettled(runtimes.map(async (runtime) => await runtime.shutdown()));
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

/** Allocates a lease and opens the app, so interaction commands have a live provider session. */
async function openWebDriverSession(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
): Promise<DeviceLease> {
  const lease = await allocateWebDriverLease(daemon);
  const open = await daemon.callCommand('open', ['com.example.demo'], leaseFlags(lease.leaseId), {
    meta: leaseMeta(lease.leaseId),
  });
  assertRpcOk(open);
  return lease;
}

function rotationCalls(server: FakeWebDriverServer): readonly CloudWebDriverHttpCall[] {
  return server.calls.filter(
    (call) => call.method === 'POST' && call.path === '/wd/hub/session/wd-1/rotation',
  );
}

function orientationCalls(server: FakeWebDriverServer): readonly CloudWebDriverHttpCall[] {
  return server.calls.filter(
    (call) => call.method === 'POST' && call.path === '/wd/hub/session/wd-1/orientation',
  );
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
      expectData: { platform: 'android', packageName: 'com.example.demo' },
    },
    {
      name: 'open',
      command: 'open',
      positionals: ['com.example.demo'],
      expectData: {
        platform: 'android',
        id: `${WEBDRIVER_PROVIDER}:android:${lease.leaseId}`,
        serial: `${WEBDRIVER_PROVIDER}:android:${lease.leaseId}`,
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

function assertWebDriverCalls(calls: readonly CloudWebDriverHttpCall[], leaseId: string): void {
  const paths = calls.map((call) => `${call.method} ${call.path}`);
  for (const expected of [
    'POST /wd/hub/session',
    'POST /app-automate/upload',
    'POST /wd/hub/session/wd-1/appium/device/install_app',
    'POST /wd/hub/session/wd-1/appium/device/activate_app',
    'POST /wd/hub/session/wd-1/actions',
    'POST /wd/hub/session/wd-1/keys',
    'GET /wd/hub/session/wd-1/source',
    'DELETE /wd/hub/session/wd-1',
    'GET /app-automate/sessions/wd-1.json',
  ]) {
    assert.ok(paths.includes(expected), `missing WebDriver transcript call: ${expected}`);
  }
  const create = calls.find((call) => call.path === '/wd/hub/session');
  assert.deepEqual(create?.body, {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:deviceName': 'Google Pixel 8',
        device: 'Google Pixel 8',
        os_version: '14.0',
        app: 'bs://app-id',
        'bstack:options': {
          projectName: 'agent-device',
          buildName: 'run-a',
          sessionName: leaseId,
        },
      },
    },
  });
  const install = calls.find((call) => call.path.endsWith('/appium/device/install_app'));
  assert.deepEqual(install?.body, { appPath: 'bs://uploaded-app' });
  for (const call of calls) {
    assert.equal(call.headers['x-agent-device-client'], 'agent-device-cli');
    assert.equal(call.headers['x-agent-device-version'], CLIENT_VERSION);
  }
}

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
/** Spans the viewport, so whatever coordinate a scenario fills lands inside it. */
const FOCUSED_FIELD_RECT = { x: 0, y: 0, width: 1080, height: 1920 };

class FakeWebDriverServer extends CloudWebDriverTestServer {
  artifactFailuresRemaining = 0;
  sessionDeleteFailuresRemaining = 0;
  /**
   * How the driver answers `POST /rotation`. `unsupported` is a driver that does not implement the
   * route; `server-error` is one that implements it and failed. Orientation must treat those
   * differently — only the first earns a fallback.
   */
  rotationBehavior: 'ok' | 'unsupported' | 'server-error' = 'ok';

  static async start(): Promise<StartedCloudWebDriverTestServer<FakeWebDriverServer>> {
    return await startCloudWebDriverTestServer(new FakeWebDriverServer());
  }

  protected respond(call: CloudWebDriverHttpCall) {
    // Routes are a table rather than a switch: every added endpoint would otherwise widen one
    // function's branch count, and this fake grows an endpoint per provider feature.
    if (call.method === 'GET' && /\/element\/[^/]+\/rect$/.test(call.path)) {
      return cloudWebDriverTestJson({ value: FOCUSED_FIELD_RECT });
    }
    const route = this.routes[`${call.method} ${call.path}`];
    return route ? route() : cloudWebDriverTestJson({ value: null });
  }

  private get routes(): Record<string, () => CloudWebDriverTestResponse> {
    return {
      'POST /wd/hub/session': () =>
        cloudWebDriverTestJson({
          value: { sessionId: 'wd-1', capabilities: { platformName: 'Android' } },
        }),
      'POST /app-automate/upload': () => cloudWebDriverTestJson({ app_url: 'bs://uploaded-app' }),
      'GET /wd/hub/session/wd-1/source': () =>
        cloudWebDriverTestJson({ value: fakeWebDriverSource() }),
      'GET /wd/hub/session/wd-1/window/rect': () =>
        cloudWebDriverTestJson({ value: { x: 0, y: 0, width: 1080, height: 1920 } }),
      'DELETE /wd/hub/session/wd-1/actions': () =>
        cloudWebDriverTestJson(
          { value: { message: 'The requested resource could not be found.' } },
          500,
        ),
      // This fake stands in for a conformant driver, so it answers the focus
      // probes `fill` witnesses with. Text-entry semantics themselves live in
      // cloud-webdriver-ios-text-entry.test.ts, which models focus properly;
      // here the field is simply always focused so the facade wiring is what
      // the scenario exercises.
      'GET /wd/hub/session/wd-1/element/active': () =>
        cloudWebDriverTestJson({ value: { [W3C_ELEMENT_KEY]: 'focused-field' } }),
      'GET /wd/hub/session/wd-1/appium/device/is_keyboard_shown': () =>
        cloudWebDriverTestJson({ value: true }),
      'POST /wd/hub/session/wd-1/rotation': () => this.rotationResponse(),
      'POST /wd/hub/session/wd-1/orientation': () => cloudWebDriverTestJson({ value: null }),
      'DELETE /wd/hub/session/wd-1': () => this.deleteSessionResponse(),
      'GET /app-automate/sessions/wd-1.json': () => this.artifactResponse(),
    };
  }

  private rotationResponse() {
    if (this.rotationBehavior === 'unsupported') {
      return cloudWebDriverTestJson(
        { value: { error: 'unknown command', message: 'Unknown command: rotation' } },
        404,
      );
    }
    if (this.rotationBehavior === 'server-error') {
      return cloudWebDriverTestJson(
        { value: { message: 'provider rotation backend failed' } },
        502,
      );
    }
    return cloudWebDriverTestJson({ value: 'ROTATION_0' });
  }

  private deleteSessionResponse() {
    if (this.sessionDeleteFailuresRemaining > 0) {
      this.sessionDeleteFailuresRemaining -= 1;
      return cloudWebDriverTestJson({ value: { message: 'stale webdriver session' } }, 500);
    }
    return cloudWebDriverTestJson({ value: null });
  }

  private artifactResponse() {
    if (this.artifactFailuresRemaining > 0) {
      this.artifactFailuresRemaining -= 1;
      return cloudWebDriverTestJson({ message: 'provider artifact lookup failed' }, 500);
    }
    return cloudWebDriverTestJson({
      automation_session: {
        video_url: 'https://provider.example/video.mp4',
        appium_logs_url: 'https://provider.example/appium.log',
        device_logs_url: 'https://provider.example/device.log',
        browser_url: 'https://provider.example/session',
        public_url: 'https://provider.example/public',
      },
    });
  }
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
    device: 'Google Pixel 8',
    providerApp: 'bs://app-id',
    providerOsVersion: '14.0',
    providerProject: 'agent-device',
    providerBuild: 'run-a',
    providerSessionName: leaseId,
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
