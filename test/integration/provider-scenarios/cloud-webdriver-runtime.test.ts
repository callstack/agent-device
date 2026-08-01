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
    deviceInventoryProvider: providers.deviceInventoryProvider!,
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

class FakeWebDriverServer extends CloudWebDriverTestServer {
  artifactFailuresRemaining = 0;
  sessionDeleteFailuresRemaining = 0;

  static async start(): Promise<StartedCloudWebDriverTestServer<FakeWebDriverServer>> {
    return await startCloudWebDriverTestServer(new FakeWebDriverServer());
  }

  protected respond(call: CloudWebDriverHttpCall) {
    switch (`${call.method} ${call.path}`) {
      case 'POST /wd/hub/session':
        return cloudWebDriverTestJson({
          value: { sessionId: 'wd-1', capabilities: { platformName: 'Android' } },
        });
      case 'POST /app-automate/upload':
        return cloudWebDriverTestJson({ app_url: 'bs://uploaded-app' });
      case 'GET /wd/hub/session/wd-1/source':
        return cloudWebDriverTestJson({ value: fakeWebDriverSource() });
      case 'GET /wd/hub/session/wd-1/window/rect':
        return cloudWebDriverTestJson({ value: { x: 0, y: 0, width: 1080, height: 1920 } });
      case 'DELETE /wd/hub/session/wd-1/actions':
        return cloudWebDriverTestJson(
          { value: { message: 'The requested resource could not be found.' } },
          500,
        );
      case 'DELETE /wd/hub/session/wd-1':
        return this.deleteSessionResponse();
      case 'GET /app-automate/sessions/wd-1.json':
        return this.artifactResponse();
      default:
        return cloudWebDriverTestJson({ value: null });
    }
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
