import assert from 'node:assert/strict';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { createCloudWebDriverRuntime } from '../../../src/cloud-webdriver.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import { assertRpcOk } from './assertions.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';
import { runProviderScenario, type ProviderScenarioStep } from './scenario.ts';

const WEBDRIVER_PROVIDER = 'webdriver-fake';

type WebDriverHttpCall = {
  method: string;
  path: string;
  body?: unknown;
};

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
        cloudArtifacts?: unknown[];
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

async function createCloudWebDriverWorld() {
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
  calls: readonly WebDriverHttpCall[],
  leaseId: string,
  appPath: string,
): void {
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'POST /wd/hub/session',
      'POST /wd/hub/session/wd-1/appium/device/install_app',
      'POST /wd/hub/session/wd-1/execute/sync',
      'POST /wd/hub/session/wd-1/actions',
      'DELETE /wd/hub/session/wd-1/actions',
      'POST /wd/hub/session/wd-1/actions',
      'DELETE /wd/hub/session/wd-1/actions',
      'POST /wd/hub/session/wd-1/keys',
      'GET /wd/hub/session/wd-1/source',
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
  assert.deepEqual(calls[2]?.body, {
    script: 'mobile: activateApp',
    args: [{ appId: 'com.example.demo', bundleId: 'com.example.demo' }],
  });
  assert.deepEqual(calls[7]?.body, { text: 'hello cloud', value: Array.from('hello cloud') });
}

class FakeWebDriverServer {
  readonly calls: WebDriverHttpCall[] = [];
  url = '';

  private readonly server: http.Server;

  private constructor(server: http.Server) {
    this.server = server;
  }

  static async start(): Promise<FakeWebDriverServer> {
    const instance = new FakeWebDriverServer(http.createServer());
    instance.server.on('request', async (req, res) => await instance.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(0, '127.0.0.1', resolve);
    });
    const address = instance.server.address();
    assert.ok(address && typeof address === 'object');
    instance.url = `http://127.0.0.1:${address.port}`;
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const call: WebDriverHttpCall = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
    };
    const body = await readJsonBody(req);
    if (body !== undefined) call.body = body;
    this.calls.push(call);
    this.respond(call, res);
  }

  private respond(call: WebDriverHttpCall, res: ServerResponse): void {
    if (call.method === 'POST' && call.path === '/wd/hub/session') {
      writeJson(res, {
        value: {
          sessionId: 'wd-1',
          capabilities: { platformName: 'Android' },
        },
      });
      return;
    }
    if (call.method === 'GET' && call.path === '/wd/hub/session/wd-1/source') {
      writeJson(res, {
        value:
          '<hierarchy><node text="Root" bounds="[0,0][100,40]" displayed="true">' +
          '<node text="Login" resource-id="com.example:id/login" bounds="[10,20][110,70]" displayed="true" />' +
          '</node></hierarchy>',
      });
      return;
    }
    if (call.method === 'DELETE' && call.path === '/wd/hub/session/wd-1/actions') {
      writeJson(
        res,
        {
          value: {
            message: 'The requested resource could not be found.',
          },
        },
        500,
      );
      return;
    }
    writeJson(res, { value: null });
  }
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
