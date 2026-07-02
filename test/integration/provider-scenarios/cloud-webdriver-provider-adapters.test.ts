import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import {
  createAwsCliDeviceFarmClient,
  createAwsDeviceFarmWebDriverRuntime,
  getAwsDeviceFarmWebDriverCapabilities,
  listAwsDeviceFarmCloudArtifacts,
  selectAwsDeviceFarmWebDriverEndpoint,
  type AwsDeviceFarmClient,
} from '../../../src/cloud-webdriver/aws-device-farm.ts';
import {
  createBrowserStackWebDriverRuntime,
  getBrowserStackWebDriverCapabilities,
  listBrowserStackCloudArtifacts,
  uploadBrowserStackApp,
} from '../../../src/cloud-webdriver/browserstack.ts';
import type { CloudArtifactsResult } from '../../../src/cloud-artifacts.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import { withCommandExecutorOverride } from '../../../src/utils/exec.ts';
import { withProviderScenarioResource, withProviderScenarioTempDir } from './harness.ts';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
  writeCloudWebDriverTestJson,
} from './cloud-webdriver-test-server.ts';

test('BrowserStack adapter prepares App Automate capabilities and uploads install artifacts', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    await withProviderScenarioTempDir('agent-device-browserstack-adapter-', async (tempDir) => {
      const appPath = path.join(tempDir, 'demo.apk');
      fs.writeFileSync(appPath, 'fake apk');
      const lease = makeLease('browserstack');
      const runtime = createBrowserStackWebDriverRuntime({
        username: 'user',
        accessKey: 'key',
        endpoint: `${server.url}/wd/hub/`,
        uploadEndpoint: `${server.url}/app-automate/upload`,
        sessionDetailsEndpoint: `${server.url}/app-automate/sessions`,
        platform: 'android',
        deviceName: 'Google Pixel 8',
        osVersion: '14.0',
        app: 'bs://preuploaded',
        projectName: 'agent-device',
        buildName: (lease) => `build-${lease.runId}`,
        sessionName: (lease) => `session-${lease.leaseId}`,
      });
      try {
        await runtime.leaseLifecycle.allocate?.(lease);
        const [device] =
          (await runtime.deviceInventoryProvider({
            leaseProvider: 'browserstack',
            leaseId: lease.leaseId,
            platform: 'android',
          })) ?? [];
        assert.ok(device);
        await runtime.installApp?.(device, 'com.example.demo', appPath, {
          packageNameHint: 'com.example.demo',
        });
        const release = await runtime.leaseLifecycle.release?.(lease);
        assert.equal(
          (release?.cloudArtifacts as CloudArtifactsResult | undefined)?.cloudArtifacts.length,
          5,
        );
      } finally {
        await runtime.shutdown();
      }
      assertBrowserStackCalls(server.calls, lease);
    });
  });
}, 15_000);

test('cloud provider adapters declare command capabilities explicitly', () => {
  const browserStack = getBrowserStackWebDriverCapabilities('android');
  assert.equal(browserStack.operations.snapshot.support, 'partial');
  assert.equal(browserStack.operations.install.support, 'partial');
  assert.equal(browserStack.operations.artifacts.support, 'supported');
  assert.equal(browserStack.operations.nativeSnapshotBackend.support, 'unsupported');
  assert.match(browserStack.operations.portReverse.note ?? '', /BrowserStack Local/);

  const aws = getAwsDeviceFarmWebDriverCapabilities('android');
  assert.equal(aws.operations.snapshot.support, 'partial');
  assert.equal(aws.operations.install.support, 'unsupported');
  assert.equal(aws.operations.artifacts.support, 'supported');
  assert.match(aws.operations.install.note ?? '', /appArn/);
  assert.equal(aws.operations.nativeSnapshotBackend.support, 'unsupported');
});

test('AWS Device Farm adapter selects WebDriver endpoint and stops remote access on release', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const lease = makeLease('aws-device-farm');
    const client = new FakeAwsDeviceFarmClient(`${server.url}/wd/hub/`);
    const runtime = createAwsDeviceFarmWebDriverRuntime({
      client,
      projectArn: 'arn:aws:devicefarm:us-west-2:123:project/project-id',
      deviceArn: 'arn:aws:devicefarm:us-west-2::device/device-id',
      platform: 'android',
      deviceName: 'Google Pixel 8',
      sessionName: (lease) => `aws-${lease.leaseId}`,
      pollIntervalMs: 1,
    });
    try {
      const allocation = await runtime.leaseLifecycle.allocate?.(lease);
      assert.equal(allocation?.awsDeviceFarmSessionArn, client.sessionArn);
      const release = await runtime.leaseLifecycle.release?.(lease);
      assert.equal(
        (release?.cloudArtifacts as CloudArtifactsResult | undefined)?.cloudArtifacts.length,
        3,
      );
    } finally {
      await runtime.shutdown();
    }
    assert.deepEqual(client.calls, [
      'create:aws-lease1',
      'get:arn:aws:devicefarm:session/fake',
      'stop:arn:aws:devicefarm:session/fake',
      'list:arn:aws:devicefarm:session/fake:FILE',
      'list:arn:aws:devicefarm:session/fake:LOG',
    ]);
    assert.equal(server.calls[0]?.path, '/wd/hub/session');
    assertAgentDeviceHeaders(server.calls[0]?.headers);
    assert.equal(server.calls.at(-1)?.path, '/wd/hub/session/wd-1');
  });
}, 15_000);

test('AWS Device Farm adapter sends the requested platform in WebDriver capabilities', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const lease = makeLease('aws-device-farm');
    const client = new FakeAwsDeviceFarmClient(`${server.url}/wd/hub/`, {
      name: 'Apple iPhone 13',
      platform: 'IOS',
      os: '16.0.2',
    });
    const runtime = createAwsDeviceFarmWebDriverRuntime({
      client,
      projectArn: 'arn:aws:devicefarm:us-west-2:123:project/project-id',
      deviceArn: 'arn:aws:devicefarm:us-west-2::device/device-id',
      platform: 'ios',
      deviceName: 'AWS Device Farm device',
      pollIntervalMs: 1,
    });
    try {
      await runtime.leaseLifecycle.allocate?.(lease);
    } finally {
      await runtime.leaseLifecycle.release?.(lease);
      await runtime.shutdown();
    }
    assert.equal(server.calls[0]?.path, '/wd/hub/session');
    assert.deepEqual(server.calls[0]?.body, {
      capabilities: {
        alwaysMatch: {
          platformName: 'iOS',
          'appium:deviceName': 'Apple iPhone 13',
        },
      },
    });
  });
}, 15_000);

test('AWS Device Farm adapter rejects local artifact install until upload support exists', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    await withProviderScenarioTempDir('agent-device-aws-install-unsupported-', async (tempDir) => {
      const appPath = path.join(tempDir, 'demo.apk');
      fs.writeFileSync(appPath, 'fake apk');
      const lease = makeLease('aws-device-farm');
      const client = new FakeAwsDeviceFarmClient(`${server.url}/wd/hub/`);
      const runtime = createAwsDeviceFarmWebDriverRuntime({
        client,
        projectArn: 'arn:aws:devicefarm:us-west-2:123:project/project-id',
        deviceArn: 'arn:aws:devicefarm:us-west-2::device/device-id',
        platform: 'android',
        deviceName: 'Google Pixel 8',
        pollIntervalMs: 1,
      });
      try {
        await runtime.leaseLifecycle.allocate?.(lease);
        const [device] =
          (await runtime.deviceInventoryProvider({
            leaseProvider: 'aws-device-farm',
            leaseId: lease.leaseId,
            platform: 'android',
          })) ?? [];
        assert.ok(device);
        assert.ok(runtime.installApp);
        await assert.rejects(
          () => runtime.installApp!(device, 'com.example.demo', appPath),
          /local artifact upload\/install is not implemented/,
        );
      } finally {
        await runtime.leaseLifecycle.release?.(lease);
        await runtime.shutdown();
      }
    });
  });
}, 15_000);

test('WebDriver session creation retries transient provider failures', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    server.sessionFailuresRemaining = 1;
    const lease = makeLease('browserstack');
    const runtime = createBrowserStackWebDriverRuntime({
      username: 'user',
      accessKey: 'key',
      endpoint: `${server.url}/wd/hub/`,
      uploadEndpoint: `${server.url}/app-automate/upload`,
      sessionDetailsEndpoint: `${server.url}/app-automate/sessions`,
      platform: 'android',
      deviceName: 'Google Pixel 8',
      osVersion: '14.0',
      requestPolicy: {
        retryAttempts: 1,
        retryDelayMs: 1,
      },
    });
    try {
      const allocation = await runtime.leaseLifecycle.allocate?.(lease);
      assert.equal(allocation?.provider, 'browserstack');
      await runtime.leaseLifecycle.release?.(lease);
    } finally {
      await runtime.shutdown();
    }
    assert.equal(server.calls.filter((call) => call.path === '/wd/hub/session').length, 2);
  });
}, 15_000);

test('AWS Device Farm endpoint selection skips live-control WebSocket URLs', () => {
  assert.equal(
    selectAwsDeviceFarmWebDriverEndpoint({
      arn: 'arn',
      remoteDebugUrl: 'wss://live-control.example/socket',
      endpoints: {
        video: 'wss://video.example/socket',
        appium: 'devicefarm-appium.example/wd/hub/',
      },
    }),
    'http://devicefarm-appium.example/wd/hub/',
  );
});

test('BrowserStack upload helper returns uploaded app reference', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    await withProviderScenarioTempDir('agent-device-browserstack-upload-', async (tempDir) => {
      const appPath = path.join(tempDir, 'demo.apk');
      fs.writeFileSync(appPath, 'fake apk');
      const appUrl = await uploadBrowserStackApp(appPath, {
        username: 'user',
        accessKey: 'key',
        endpoint: `${server.url}/app-automate/upload`,
      });
      assert.equal(appUrl, 'bs://uploaded-app');
      assert.equal(server.calls[0]?.path, '/app-automate/upload');
      assertAgentDeviceHeaders(server.calls[0]?.headers);
    });
  });
}, 15_000);

test('BrowserStack session details map provider-hosted cloud artifacts', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const result = await listBrowserStackCloudArtifacts('browserstack', 'wd-1', {
      username: 'user',
      accessKey: 'key',
      endpoint: `${server.url}/app-automate/sessions`,
    });
    assert.equal(result?.status, 'ready');
    assert.deepEqual(
      result?.cloudArtifacts.map((artifact) => artifact.kind),
      ['video', 'appium-log', 'device-log', 'provider-session', 'provider-session'],
    );
  });
});

test('AWS Device Farm artifacts map to shared cloud artifact kinds', async () => {
  const client = new FakeAwsDeviceFarmClient('http://provider.example/wd/hub/');
  const result = await listAwsDeviceFarmCloudArtifacts(
    'aws-device-farm',
    client.sessionArn,
    client,
  );
  assert.deepEqual(
    result?.cloudArtifacts.map((artifact) => artifact.kind),
    ['video', 'device-log', 'appium-log'],
  );
});

test('AWS CLI Device Farm client maps remote access commands', async () => {
  const calls: string[][] = [];
  const client = createAwsCliDeviceFarmClient({ region: 'us-west-2', awsCommand: 'aws' });
  await withCommandExecutorOverride(
    async (cmd, args) => {
      calls.push([cmd, ...args]);
      return {
        stdout: JSON.stringify({ remoteAccessSession: { arn: 'arn', status: 'RUNNING' } }),
        stderr: '',
        exitCode: 0,
      };
    },
    async () => {
      await client.createRemoteAccessSession({
        projectArn: 'project',
        deviceArn: 'device',
        name: 'session',
      });
      await client.getRemoteAccessSession('arn');
      await client.stopRemoteAccessSession('arn');
      await client.listArtifacts('arn', 'FILE');
    },
  );
  assert.deepEqual(calls, [
    [
      'aws',
      'devicefarm',
      'create-remote-access-session',
      '--region',
      'us-west-2',
      '--project-arn',
      'project',
      '--device-arn',
      'device',
      '--name',
      'session',
      '--output',
      'json',
    ],
    [
      'aws',
      'devicefarm',
      'get-remote-access-session',
      '--region',
      'us-west-2',
      '--arn',
      'arn',
      '--output',
      'json',
    ],
    [
      'aws',
      'devicefarm',
      'stop-remote-access-session',
      '--region',
      'us-west-2',
      '--arn',
      'arn',
      '--output',
      'json',
    ],
    [
      'aws',
      'devicefarm',
      'list-artifacts',
      '--region',
      'us-west-2',
      '--arn',
      'arn',
      '--type',
      'FILE',
      '--output',
      'json',
    ],
  ]);
});

function assertBrowserStackCalls(
  calls: readonly CloudWebDriverHttpCall[],
  lease: DeviceLease,
): void {
  assertCallPathAndHeaders(calls, 0, '/wd/hub/session');
  assert.deepEqual(calls[0]?.body, {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:deviceName': 'Google Pixel 8',
        device: 'Google Pixel 8',
        os_version: '14.0',
        app: 'bs://preuploaded',
        'bstack:options': {
          projectName: 'agent-device',
          buildName: 'build-run-a',
          sessionName: `session-${lease.leaseId}`,
        },
      },
    },
  });
  assertCallPathAndHeaders(calls, 1, '/app-automate/upload');
  assertCallPathAndHeaders(calls, 2, '/wd/hub/session/wd-1/appium/device/install_app');
  assert.deepEqual(calls[2]?.body, { appPath: 'bs://uploaded-app' });
  assertCallPathAndHeaders(calls, -2, '/wd/hub/session/wd-1');
  assertCallPathAndHeaders(calls, -1, '/app-automate/sessions/wd-1.json');
}

function assertCallPathAndHeaders(
  calls: readonly CloudWebDriverHttpCall[],
  index: number,
  expectedPath: string,
): void {
  const call = index < 0 ? calls.at(index) : calls[index];
  assert.equal(call?.path, expectedPath);
  assertAgentDeviceHeaders(call?.headers);
}

function assertAgentDeviceHeaders(headers: IncomingHttpHeaders | undefined): void {
  assert.equal(headers?.['x-agent-device-client'], 'agent-device-cli');
  assert.equal(typeof headers?.['x-agent-device-version'], 'string');
  assert.notEqual(headers?.['x-agent-device-version'], '');
}

class FakeAwsDeviceFarmClient implements AwsDeviceFarmClient {
  readonly sessionArn = 'arn:aws:devicefarm:session/fake';
  readonly calls: string[] = [];
  private readonly webDriverEndpoint: string;
  private readonly device: { name: string; platform: string; os: string };

  constructor(
    webDriverEndpoint: string,
    device: { name: string; platform: string; os: string } = {
      name: 'Google Pixel 8',
      platform: 'ANDROID',
      os: '14',
    },
  ) {
    this.webDriverEndpoint = webDriverEndpoint;
    this.device = device;
  }

  async createRemoteAccessSession(input: { name: string }) {
    this.calls.push(`create:${input.name}`);
    return { arn: this.sessionArn, status: 'PENDING' };
  }

  async getRemoteAccessSession(arn: string) {
    this.calls.push(`get:${arn}`);
    return {
      arn,
      status: 'RUNNING',
      remoteDebugUrl: 'wss://live-control.example/socket',
      endpoints: {
        appium: this.webDriverEndpoint,
      },
      device: this.device,
    };
  }

  async stopRemoteAccessSession(arn: string) {
    this.calls.push(`stop:${arn}`);
    return { arn, status: 'STOPPING' };
  }

  async listArtifacts(arn: string, type: 'FILE' | 'LOG' | 'SCREENSHOT') {
    this.calls.push(`list:${arn}:${type}`);
    if (type === 'FILE') {
      return [
        {
          arn: `${arn}/video`,
          name: 'VIDEO',
          type: 'VIDEO',
          extension: 'mp4',
          url: 'https://aws.example/video.mp4',
        },
        {
          arn: `${arn}/device-log`,
          name: 'DEVICE_LOG',
          type: 'DEVICE_LOG',
          extension: 'log',
          url: 'https://aws.example/device.log',
        },
      ];
    }
    if (type === 'LOG') {
      return [
        {
          arn: `${arn}/appium-log`,
          name: 'APPIUM_SERVER_OUTPUT',
          type: 'APPIUM_SERVER_OUTPUT',
          extension: 'log',
          url: 'https://aws.example/appium.log',
        },
      ];
    }
    return [];
  }
}

class FakeCloudProviderServer extends CloudWebDriverTestServer {
  sessionFailuresRemaining = 0;

  static async start(): Promise<StartedCloudWebDriverTestServer<FakeCloudProviderServer>> {
    return await startCloudWebDriverTestServer(new FakeCloudProviderServer());
  }

  protected respond(call: CloudWebDriverHttpCall, res: ServerResponse): void {
    if (call.method === 'POST' && call.path === '/wd/hub/session') {
      if (this.sessionFailuresRemaining > 0) {
        this.sessionFailuresRemaining -= 1;
        writeCloudWebDriverTestJson(res, { value: { message: 'transient provider failure' } }, 503);
        return;
      }
      writeCloudWebDriverTestJson(res, { value: { sessionId: 'wd-1', capabilities: {} } });
      return;
    }
    if (call.method === 'POST' && call.path === '/app-automate/upload') {
      writeCloudWebDriverTestJson(res, { app_url: 'bs://uploaded-app' });
      return;
    }
    if (call.method === 'GET' && call.path === '/app-automate/sessions/wd-1.json') {
      writeCloudWebDriverTestJson(res, {
        automation_session: {
          video_url: 'https://browserstack.example/video.mp4',
          appium_logs_url: 'https://browserstack.example/appium.log',
          device_logs_url: 'https://browserstack.example/device.log',
          browser_url: 'https://browserstack.example/dashboard',
          public_url: 'https://browserstack.example/public',
        },
      });
      return;
    }
    writeCloudWebDriverTestJson(res, { value: null });
  }
}

function makeLease(provider: string): DeviceLease {
  const now = Date.now();
  return {
    leaseId: 'lease1',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: provider,
    deviceKey: 'device-a',
    clientId: 'client-a',
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + 60_000,
  };
}
