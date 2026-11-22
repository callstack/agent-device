import { BROWSERSTACK_PROVIDER, createBrowserStackRuntime } from './browserstack-runtime.ts';
import { AWS_DEVICE_FARM_PROVIDER, createAwsDeviceFarmRuntime } from './aws-runtime.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import type { CloudArtifactsResult } from '@agent-device/contracts/observability';
import { withProviderScenarioResource, withProviderScenarioTempDir } from './harness.ts';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  cloudWebDriverTestJson,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
} from './cloud-webdriver-test-server.ts';

import testmu from '@agent-device/testmu';
import { createPluginHost, type RunHostCommand } from '@agent-device/plugins/host';

const CLIENT_VERSION = '0.20.3-test';

test('BrowserStack facade prepares capabilities, uploads apps, and returns artifacts', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    await withProviderScenarioTempDir('agent-device-browserstack-adapter-', async (tempDir) => {
      const appPath = path.join(tempDir, 'demo.apk');
      fs.writeFileSync(appPath, 'fake apk');
      const runtime = await createBrowserStackRuntime({
        env: {
          BROWSERSTACK_USERNAME: 'user',
          BROWSERSTACK_ACCESS_KEY: 'key',
          BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
          BROWSERSTACK_APP_UPLOAD_ENDPOINT: `${server.url}/app-automate/upload`,
          BROWSERSTACK_SESSION_DETAILS_ENDPOINT: `${server.url}/app-automate/sessions`,
        },
        clientVersion: CLIENT_VERSION,
      });
      const lease = makeLease(BROWSERSTACK_PROVIDER);
      try {
        const allocation = await runtime.leaseLifecycle.allocate?.(
          lease,
          browserStackContext(lease),
        );
        assert.equal(allocation?.providerSessionId, 'wd-1');
        assert.equal(operationSupport(allocation, 'snapshot'), 'partial');
        assert.equal(operationSupport(allocation, 'install'), 'partial');
        assert.equal(operationSupport(allocation, 'artifacts'), 'supported');
        assert.equal(operationSupport(allocation, 'nativeSnapshotBackend'), 'unsupported');
        assert.match(operationNote(allocation, 'portReverse') ?? '', /BrowserStack Local/);

        const [device] =
          (await runtime.deviceInventoryProvider({
            leaseProvider: runtime.provider,
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

test('BrowserStack lease allocation records a driver diagnostic in the active request log', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    server.sessionRouteUnsupported = true;
    await withProviderScenarioTempDir('agent-device-webdriver-diagnostics-', async (tempDir) => {
      const logPath = path.join(tempDir, 'request.ndjson');
      const runtime = await createBrowserStackRuntime({
        env: {
          BROWSERSTACK_USERNAME: 'user',
          BROWSERSTACK_ACCESS_KEY: 'key',
          BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
        },
        clientVersion: CLIENT_VERSION,
      });
      const lease = makeLease(BROWSERSTACK_PROVIDER);
      try {
        await withDiagnosticsScope(
          { command: 'lease_allocate', requestId: 'request-1', debug: true, logPath },
          async () => {
            await assert.rejects(
              runtime.leaseLifecycle.allocate!(lease, browserStackContext(lease)),
              (error: unknown) =>
                error instanceof AppError &&
                error.details?.reason === 'webdriver_route_unsupported',
            );
          },
        );
        const line = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        assert.deepEqual(
          { phase: line.phase, requestId: line.requestId, data: line.data },
          {
            phase: 'webdriver_route_unsupported',
            requestId: 'request-1',
            data: { method: 'POST', path: '/session', status: 404, code: 'unknown command' },
          },
        );
      } finally {
        await runtime.shutdown();
      }
    });
  });
});

test('BrowserStack facade nests device-feature capabilities inside bstack:options', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const runtime = await createBrowserStackRuntime({
      env: {
        BROWSERSTACK_USERNAME: 'user',
        BROWSERSTACK_ACCESS_KEY: 'key',
        BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
        BROWSERSTACK_SESSION_DETAILS_ENDPOINT: `${server.url}/app-automate/sessions`,
      },
      clientVersion: CLIENT_VERSION,
    });
    const lease = makeLease(BROWSERSTACK_PROVIDER);
    const context = browserStackContext(lease);
    try {
      await runtime.leaseLifecycle.allocate?.(lease, {
        flags: {
          ...context.flags,
          providerDeviceOrientation: 'portrait',
          providerGeoLocation: 'US',
          providerTimezone: 'New_York',
          providerAppiumVersion: '3.2.0',
          providerLanguage: 'Fr',
          providerLocale: 'Fr',
          providerNetworkProfile: '4g-lte-advanced-good',
        },
      });
    } finally {
      await runtime.shutdown();
    }

    const session = server.calls.find((call) => call.path === '/wd/hub/session');
    const alwaysMatch = (
      session?.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } } | undefined
    )?.capabilities?.alwaysMatch;
    // Device features merge into bstack:options rather than replacing it, so the session labels
    // built alongside them survive.
    assert.deepEqual(alwaysMatch?.['bstack:options'], {
      projectName: 'agent-device',
      buildName: `build-${lease.runId}`,
      sessionName: `session-${lease.leaseId}`,
      deviceOrientation: 'portrait',
      geoLocation: 'US',
      timezone: 'New_York',
      appiumVersion: '3.2.0',
      language: 'Fr',
      locale: 'Fr',
      networkProfile: '4g-lte-advanced-good',
    });
    // Vendor capabilities stay nested, and no legacy JSON Wire selector reaches the top level —
    // the hub would otherwise treat the request as legacy and ignore bstack:options entirely.
    assert.equal(alwaysMatch?.deviceOrientation, undefined);
    for (const legacyKey of ['device', 'os_version', 'app', 'project', 'build', 'name']) {
      assert.equal(alwaysMatch?.[legacyKey], undefined, `legacy key ${legacyKey} leaked`);
    }
  });
}, 15_000);

test('AWS Device Farm facade rejects device features it does not read at session preparation', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const host = new FakeAwsHostCommand(`${server.url}/wd/hub/`);
    const runtime = await createAwsDeviceFarmRuntime({
      env: { AWS_REGION: 'us-west-2' },
      clientVersion: CLIENT_VERSION,
      runHostCommand: host.run,
    });
    const lease = makeLease(AWS_DEVICE_FARM_PROVIDER);
    const context = awsContext(lease);

    try {
      // Straight at the runtime boundary, bypassing the CLI profile builder entirely — this is the
      // route a typed client or a hand-authored remote-config profile takes.
      await assert.rejects(
        async () =>
          await runtime.leaseLifecycle.allocate?.(lease, {
            ...context,
            flags: {
              ...context.flags,
              providerDeviceOrientation: 'portrait',
              providerNetworkProfile: '4g-lte-advanced-good',
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'INVALID_ARGS');
          assert.deepEqual(error.details?.flags, [
            '--provider-device-orientation',
            '--provider-network-profile',
          ]);
          return true;
        },
      );
      // Rejected before any provider session was created, so nothing needs unwinding.
      assert.deepEqual(host.calls, []);
    } finally {
      await runtime.shutdown();
    }
  });
}, 15_000);

async function setupTestMuRuntime(env: Record<string, string>) {
  const [contribution] = testmu().contributes;
  const { runtime, platformModule } = await contribution.setup({
    ...(await createPluginHost({ env, cwd: '/' }, undefined)),
    clientVersion: CLIENT_VERSION,
  });
  return {
    runtime: runtime as ProviderDeviceRuntime,
    platformModule: platformModule as PlatformRuntimeProviderModule,
  };
}

test('TestMu facade routes a real-device session to the real pool and its upload API', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const { runtime } = await setupTestMuRuntime({
      LT_USERNAME: 'user',
      LT_ACCESS_KEY: 'key',
      TESTMU_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
      TESTMU_APP_UPLOAD_ENDPOINT: `${server.url}/lt/upload/virtualDevice`,
      TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT: `${server.url}/lt/upload/realDevice`,
    });
    const lease = makeLease('testmu');
    try {
      await runtime.leaseLifecycle.allocate?.(lease, {
        flags: {
          platform: 'android',
          device: 'Pixel 6',
          providerOsVersion: '14',
          providerDeviceType: 'real',
          providerApp: 'https://builds.example/app.apk',
        },
      });
    } finally {
      await runtime.shutdown();
    }

    assert.deepEqual(
      server.calls.filter((call) => call.path.startsWith('/lt/upload/')).map((call) => call.path),
      ['/lt/upload/realDevice'],
    );
    const session = server.calls.find((call) => call.path === '/wd/hub/session');
    const alwaysMatch = (
      session?.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } } | undefined
    )?.capabilities?.alwaysMatch;
    const ltOptions = alwaysMatch?.['lt:options'] as Record<string, unknown> | undefined;
    assert.equal(ltOptions?.isRealMobile, true);
    assert.equal(ltOptions?.app, 'lt://REAL1');
    assert.equal(ltOptions?.platformVersion, '14');
  });
}, 15_000);

test('TestMu uploads the materializer-selected simulator archive through the plugin runtime', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    await withProviderScenarioTempDir('agent-device-testmu-materialized-', async (tempDir) => {
      const archivePath = path.join(tempDir, 'App.app.zip');
      const installablePath = path.join(tempDir, 'extracted', 'App.app');
      fs.writeFileSync(archivePath, 'zip bytes');
      fs.mkdirSync(installablePath, { recursive: true });
      const { runtime, platformModule } = await setupTestMuRuntime({
        LT_USERNAME: 'user',
        LT_ACCESS_KEY: 'key',
        TESTMU_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
        TESTMU_APP_UPLOAD_ENDPOINT: `${server.url}/lt/upload/virtualDevice`,
      });
      const lease = makeLease('testmu');
      try {
        await runtime.leaseLifecycle.allocate?.(lease, {
          flags: {
            platform: 'ios',
            device: 'iPhone 16',
            providerOsVersion: '18.0',
            providerApp: 'lt://APP1',
          },
        });
        const [device] =
          (await runtime.deviceInventoryProvider({
            leaseProvider: 'testmu',
            leaseId: lease.leaseId,
            platform: 'ios',
          })) ?? [];
        assert.ok(device);
        const owner = await platformModule.loadRuntime({
          snapshot: {
            presentIosAcquisition: async () => {
              throw new Error('Unexpected snapshot');
            },
          },
        } as unknown as PlatformRuntimeHost);
        const binding = await owner.bind({
          device,
          intent: { kind: 'ordinary' },
          scope: {
            signal: new AbortController().signal,
            diagnostics: { emit: () => {} },
            progress: { report: () => {} },
          },
        });
        try {
          assert.ok(binding.operations.deployMaterializedApp);
          await binding.operations.deployMaterializedApp({
            artifact: {
              archivePath,
              installablePath,
              uploadPath: archivePath,
              cleanup: async () => {},
            },
          });
        } finally {
          await binding[Symbol.asyncDispose]();
        }
        const upload = server.calls.find((call) => call.path === '/lt/upload/virtualDevice');
        assert.deepEqual((upload?.body as { filenames?: string[] })?.filenames, ['App.app.zip']);
        const install = server.calls.find((call) =>
          call.path.endsWith('/appium/device/install_app'),
        );
        assert.deepEqual(install?.body, { appPath: 'lt://VIRTUAL1' });
      } finally {
        await runtime.shutdown();
      }
    });
  });
}, 15_000);

test('BrowserStack refuses a refused field on a repeat allocation of its live lease', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const runtime = await createBrowserStackRuntime({
      env: {
        BROWSERSTACK_USERNAME: 'user',
        BROWSERSTACK_ACCESS_KEY: 'key',
        BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
      },
      clientVersion: CLIENT_VERSION,
    });
    const lease = makeLease(BROWSERSTACK_PROVIDER);
    const context = browserStackContext(lease);
    try {
      await runtime.leaseLifecycle.allocate?.(lease, context);
      const sessionCalls = server.calls.length;
      await assert.rejects(
        async () =>
          await runtime.leaseLifecycle.allocate?.(lease, {
            flags: {
              ...context.flags,
              awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project/project-id',
            },
          }),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'INVALID_ARGS' &&
          JSON.stringify(error.details?.flags) === '["--aws-project-arn"]',
      );
      assert.equal(server.calls.length, sessionCalls);
      assert.deepEqual(await runtime.leaseLifecycle.heartbeat?.(lease), {
        provider: BROWSERSTACK_PROVIDER,
      });
    } finally {
      await runtime.shutdown();
    }
  });
}, 15_000);

test('AWS Device Farm facade uses the injected host-command capability for its full lifecycle', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const host = new FakeAwsHostCommand(`${server.url}/wd/hub/`);
    const runtime = await createAwsDeviceFarmRuntime({
      env: { AWS_REGION: 'us-west-2' },
      clientVersion: CLIENT_VERSION,
      runHostCommand: host.run,
    });
    const lease = makeLease(AWS_DEVICE_FARM_PROVIDER);
    try {
      const allocation = await runtime.leaseLifecycle.allocate?.(lease, awsContext(lease));
      assert.equal(allocation?.awsDeviceFarmSessionArn, host.sessionArn);
      assert.equal(operationSupport(allocation, 'install'), 'unsupported');
      assert.equal(operationSupport(allocation, 'artifacts'), 'supported');
      assert.equal(operationSupport(allocation, 'nativeSnapshotBackend'), 'unsupported');
      assert.match(operationNote(allocation, 'install') ?? '', /appArn/);

      const release = await runtime.leaseLifecycle.release?.(lease);
      assert.deepEqual(
        (release?.cloudArtifacts as CloudArtifactsResult | undefined)?.cloudArtifacts.map(
          (artifact) => artifact.kind,
        ),
        ['video', 'device-log', 'appium-log'],
      );
    } finally {
      await runtime.shutdown();
    }

    assert.deepEqual(host.calls, [
      [
        'aws',
        'devicefarm',
        'create-remote-access-session',
        '--region',
        'us-west-2',
        '--project-arn',
        'arn:aws:devicefarm:us-west-2:123:project/project-id',
        '--device-arn',
        'arn:aws:devicefarm:us-west-2::device/device-id',
        '--name',
        lease.leaseId,
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
        host.sessionArn,
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
        host.sessionArn,
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
        host.sessionArn,
        '--type',
        'FILE',
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
        host.sessionArn,
        '--type',
        'LOG',
        '--output',
        'json',
      ],
    ]);
    assert.equal(server.calls[0]?.path, '/wd/hub/session');
    assertAgentDeviceHeaders(server.calls[0]?.headers);
    assert.equal(server.calls.at(-1)?.path, '/wd/hub/session/wd-1');
  });
}, 15_000);

test('BrowserStack artifact lookup reuses the released provider session id', async () => {
  await withProviderScenarioResource(FakeCloudProviderServer.start, async (server) => {
    const runtime = await createBrowserStackRuntime({
      env: {
        BROWSERSTACK_USERNAME: 'user',
        BROWSERSTACK_ACCESS_KEY: 'key',
        BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
        BROWSERSTACK_SESSION_DETAILS_ENDPOINT: `${server.url}/app-automate/sessions`,
      },
      clientVersion: CLIENT_VERSION,
    });
    const lease = makeLease(BROWSERSTACK_PROVIDER);
    try {
      await runtime.leaseLifecycle.allocate!(lease, browserStackContext(lease));
      await runtime.leaseLifecycle.release!(lease);
      const beforeLookup = server.calls.length;
      const result = await runtime.cloudArtifacts!.listCloudArtifacts!({
        provider: BROWSERSTACK_PROVIDER,
        leaseId: lease.leaseId,
        providerSessionId: 'wd-1',
      });
      assert.deepEqual(
        result?.cloudArtifacts.map((artifact) => artifact.kind),
        ['video', 'appium-log', 'device-log', 'provider-session', 'provider-session'],
      );
      assert.equal(server.calls.length, beforeLookup + 1);
      assertCallPathAndHeaders(server.calls, beforeLookup, '/app-automate/sessions/wd-1.json');
    } finally {
      await runtime.shutdown();
    }
  });
});

function operationSupport(
  allocation: Record<string, unknown> | undefined,
  operation: string,
): string | undefined {
  const capabilities = allocation?.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const operations = (capabilities as { operations?: unknown }).operations;
  if (!operations || typeof operations !== 'object') return undefined;
  const entry = (operations as Record<string, unknown>)[operation];
  if (!entry || typeof entry !== 'object') return undefined;
  const support = (entry as { support?: unknown }).support;
  return typeof support === 'string' ? support : undefined;
}

function operationNote(
  allocation: Record<string, unknown> | undefined,
  operation: string,
): string | undefined {
  const capabilities = allocation?.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const operations = (capabilities as { operations?: unknown }).operations;
  if (!operations || typeof operations !== 'object') return undefined;
  const entry = (operations as Record<string, unknown>)[operation];
  if (!entry || typeof entry !== 'object') return undefined;
  const note = (entry as { note?: unknown }).note;
  return typeof note === 'string' ? note : undefined;
}

function browserStackContext(lease: DeviceLease): LeaseLifecycleContext {
  return {
    flags: {
      platform: 'android',
      device: 'Google Pixel 8',
      providerApp: 'bs://preuploaded',
      providerOsVersion: '14.0',
      providerProject: 'agent-device',
      providerBuild: `build-${lease.runId}`,
      providerSessionName: `session-${lease.leaseId}`,
    },
  };
}

function awsContext(lease: DeviceLease): LeaseLifecycleContext {
  return {
    flags: {
      platform: 'android',
      awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project/project-id',
      awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device/device-id',
      providerSessionName: lease.leaseId,
    },
  };
}

function makeLease(provider: string): DeviceLease {
  return {
    leaseId: 'lease1',
    tenantId: 'team-a',
    runId: 'run-a',
    clientId: 'client-a',
    leaseProvider: provider,
    backend: 'android-instance',
    deviceKey: 'provider-device-a',
    createdAt: 1,
    expiresAt: 2,
    heartbeatAt: 1,
  };
}

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
        'appium:platformVersion': '14.0',
        'appium:app': 'bs://preuploaded',
        'bstack:options': {
          projectName: 'agent-device',
          buildName: `build-${lease.runId}`,
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
  assert.equal(headers?.['x-agent-device-version'], CLIENT_VERSION);
}

class FakeAwsHostCommand {
  readonly sessionArn = 'arn:aws:devicefarm:session/fake';
  readonly calls: string[][] = [];
  private readonly webDriverEndpoint: string;

  constructor(webDriverEndpoint: string) {
    this.webDriverEndpoint = webDriverEndpoint;
  }

  readonly run: RunHostCommand = async (command, args) => {
    const call = [command, ...args];
    this.calls.push(call);
    const subcommand = args[1];
    if (subcommand === 'create-remote-access-session') {
      return this.result({ remoteAccessSession: { arn: this.sessionArn, status: 'PENDING' } });
    }
    if (subcommand === 'get-remote-access-session') {
      return this.result({
        remoteAccessSession: {
          arn: this.sessionArn,
          status: 'RUNNING',
          endpoints: { appium: this.webDriverEndpoint },
          device: { name: 'Google Pixel 8', platform: 'ANDROID', os: '14' },
        },
      });
    }
    if (subcommand === 'stop-remote-access-session') {
      return this.result({
        remoteAccessSession: { arn: this.sessionArn, status: 'STOPPING' },
      });
    }
    if (subcommand === 'list-artifacts') {
      return this.result({ artifacts: this.artifactsFor(args) });
    }
    throw new Error(`unexpected AWS command: ${call.join(' ')}`);
  };

  private artifactsFor(args: readonly string[]) {
    const type = args[args.indexOf('--type') + 1];
    if (type === 'FILE') {
      return [
        {
          arn: `${this.sessionArn}/video`,
          name: 'VIDEO',
          type: 'VIDEO',
          extension: 'mp4',
          url: 'https://aws.example/video.mp4',
        },
        {
          arn: `${this.sessionArn}/device-log`,
          name: 'DEVICE_LOG',
          type: 'DEVICE_LOG',
          extension: 'log',
          url: 'https://aws.example/device.log',
        },
      ];
    }
    return [
      {
        arn: `${this.sessionArn}/appium-log`,
        name: 'APPIUM_SERVER_OUTPUT',
        type: 'APPIUM_SERVER_OUTPUT',
        extension: 'log',
        url: 'https://aws.example/appium.log',
      },
    ];
  }

  private result(value: unknown): { stdout: string } {
    return { stdout: JSON.stringify(value) };
  }
}

class FakeCloudProviderServer extends CloudWebDriverTestServer {
  sessionRouteUnsupported = false;

  static async start(): Promise<StartedCloudWebDriverTestServer<FakeCloudProviderServer>> {
    return await startCloudWebDriverTestServer(new FakeCloudProviderServer());
  }

  protected respond(call: CloudWebDriverHttpCall) {
    switch (`${call.method} ${call.path}`) {
      case 'POST /wd/hub/session':
        if (this.sessionRouteUnsupported) {
          return cloudWebDriverTestJson({ value: { error: 'unknown command' } }, 404);
        }
        return cloudWebDriverTestJson({
          value: { sessionId: 'wd-1', capabilities: { platformName: 'Android' } },
        });
      case 'POST /app-automate/upload':
        return cloudWebDriverTestJson({ app_url: 'bs://uploaded-app' });
      case 'POST /lt/upload/realDevice':
        return cloudWebDriverTestJson({ app_url: 'lt://REAL1' });
      case 'POST /lt/upload/virtualDevice':
        return cloudWebDriverTestJson({ app_url: 'lt://VIRTUAL1' });
      case 'GET /app-automate/sessions/wd-1.json':
        return cloudWebDriverTestJson({
          automation_session: {
            video_url: 'https://provider.example/video.mp4',
            appium_logs_url: 'https://provider.example/appium.log',
            device_logs_url: 'https://provider.example/device.log',
            browser_url: 'https://provider.example/session',
            public_url: 'https://provider.example/public',
          },
        });
      default:
        return cloudWebDriverTestJson({ value: null });
    }
  }
}
