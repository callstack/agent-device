import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  createProviderWebDriver,
  type RunHostCommand,
} from '@agent-device/provider-webdriver';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import * as iosSnapshotRuntime from '../../../src/snapshot/ios-snapshot-runtime.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';
import { assertRpcOk } from './assertions.ts';
import {
  AwsRemoteAccessHost,
  PROVIDER_REGRESSION_CLIENT_VERSION,
  ProviderRegressionServer,
  awsRegressionContext,
  browserStackRegressionContext,
  providerRegressionLease,
  providerRuntimeFor,
} from './cloud-webdriver-regression-fixtures.ts';

test('AWS Device Farm endpoint selection skips live-control WebSocket URLs', async () => {
  await withProviderScenarioResource(ProviderRegressionServer.start, async (server) => {
    const host = new AwsRemoteAccessHost({
      appiumEndpoint: `${server.url}/wd/hub/`,
    });
    const runtime = providerRuntimeFor(
      createProviderWebDriver({
        clientVersion: PROVIDER_REGRESSION_CLIENT_VERSION,
        runHostCommand: host.run,
      }).createDefaultRuntimes({ AWS_REGION: 'us-west-2' }),
      CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    );
    const lease = providerRegressionLease(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm);
    try {
      await runtime.leaseLifecycle.allocate?.(lease, awsRegressionContext());
      assert.equal(server.calls[0]?.path, '/wd/hub/session');
      assert.equal(
        host.calls.filter((call) => call.includes('get-remote-access-session')).length,
        1,
      );
    } finally {
      await runtime.leaseLifecycle.release?.(lease);
      await runtime.shutdown();
    }
  });
});

// #1774: `POST /session` is never retried, even on a retriable-looking 5xx —
// the outcome of a failed create is indeterminate on a cloud grid, and a second
// attempt is a second billed device session. The transient failure surfaces to
// the caller, who decides whether to allocate again.
test('WebDriver session creation is not retried on transient provider failures', async () => {
  await withProviderScenarioResource(ProviderRegressionServer.start, async (server) => {
    server.sessionFailuresRemaining = 1;
    const runtime = providerRuntimeFor(
      createProviderWebDriver({
        clientVersion: PROVIDER_REGRESSION_CLIENT_VERSION,
        runHostCommand: unexpectedHostCommand,
      }).createDefaultRuntimes({
        BROWSERSTACK_USERNAME: 'user',
        BROWSERSTACK_ACCESS_KEY: 'key',
        BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
      }),
      CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    );
    const lease = providerRegressionLease(CLOUD_WEBDRIVER_PROVIDERS.browserStack);
    try {
      await assert.rejects(
        () => runtime.leaseLifecycle.allocate!(lease, browserStackRegressionContext()),
        /transient provider failure/,
      );
      assert.equal(server.calls.filter((call) => call.path === '/wd/hub/session').length, 1);
      assert.equal(await runtime.leaseLifecycle.release?.(lease), undefined);
    } finally {
      await runtime.shutdown();
    }
  });
});

test('AWS Device Farm rejects local artifact install until upload support exists', async () => {
  await withProviderScenarioResource(ProviderRegressionServer.start, async (server) => {
    await withProviderScenarioTempDir('agent-device-aws-install-unsupported-', async (tempDir) => {
      const appPath = path.join(tempDir, 'demo.apk');
      fs.writeFileSync(appPath, 'fake apk');
      const host = new AwsRemoteAccessHost({
        appiumEndpoint: `${server.url}/wd/hub/`,
      });
      const runtime = providerRuntimeFor(
        createProviderWebDriver({
          clientVersion: PROVIDER_REGRESSION_CLIENT_VERSION,
          runHostCommand: host.run,
        }).createDefaultRuntimes({ AWS_REGION: 'us-west-2' }),
        CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
      );
      const lease = providerRegressionLease(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm);
      try {
        await runtime.leaseLifecycle.allocate?.(lease, awsRegressionContext());
        const [device] =
          (await runtime.deviceInventoryProvider({
            leaseProvider: runtime.provider,
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
});

test('an active AWS Device Farm owner binds no install-family deployment operations', async () => {
  await withProviderScenarioResource(ProviderRegressionServer.start, async (server) => {
    const host = new AwsRemoteAccessHost({ appiumEndpoint: `${server.url}/wd/hub/` });
    const runtimes = createProviderWebDriver({
      clientVersion: PROVIDER_REGRESSION_CLIENT_VERSION,
      runHostCommand: host.run,
    }).createDefaultRuntimes({ AWS_REGION: 'us-west-2' });
    const runtime = runtimes.find(
      (candidate) => candidate.provider === CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    );
    assert.ok(runtime, 'Expected AWS Device Farm runtime');
    const lease = providerRegressionLease(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm);

    try {
      await runtime.leaseLifecycle.allocate?.(lease, awsRegressionContext());
      const [device] =
        (await runtime.deviceInventoryProvider({
          leaseProvider: runtime.provider,
          leaseId: lease.leaseId,
          platform: 'android',
        })) ?? [];
      assert.ok(device, 'Expected active AWS Device Farm device');
      const owner = await runtime.platformRuntimeModule.loadRuntime({
        snapshot: {
          captureSurface: async () => ({
            backend: 'xctest' as const,
            producer: 'appium-source' as const,
            nodes: [],
          }),
          presentIosAcquisition: async () => ({
            backend: 'xctest' as const,
            producer: 'appium-source' as const,
            nodes: [],
          }),
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
        for (const operation of [
          'deployApp',
          'materializeAppSource',
          'deployMaterializedApp',
        ] as const) {
          const fact = binding.facts.operations[operation];
          assert.equal(fact.available, false);
          if (fact.available) throw new Error(`Expected ${operation} to be unavailable`);
          assert.equal(fact.reason, 'owner-capability-missing');
          assert.match(fact.hint ?? '', /local artifact upload\/install is not implemented/);
          assert.equal(binding.operations[operation], undefined);
        }
      } finally {
        await binding[Symbol.asyncDispose]();
      }
    } finally {
      await runtime.leaseLifecycle.release?.(lease);
      await runtime.shutdown();
    }
  });
});

test('AWS Device Farm sends the requested platform in WebDriver capabilities', async () => {
  await withProviderScenarioResource(ProviderRegressionServer.start, async (server) => {
    const host = new AwsRemoteAccessHost({
      appiumEndpoint: `${server.url}/wd/hub/`,
      device: { name: 'Apple iPhone 13', platform: 'IOS', os: '16.0.2' },
    });
    const runtime = providerRuntimeFor(
      createProviderWebDriver({
        clientVersion: PROVIDER_REGRESSION_CLIENT_VERSION,
        runHostCommand: host.run,
      }).createDefaultRuntimes({ AWS_REGION: 'us-west-2' }),
      CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    );
    const lease = providerRegressionLease(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm);
    try {
      await runtime.leaseLifecycle.allocate?.(lease, awsRegressionContext('ios'));
      assert.deepEqual(server.calls[0]?.body, {
        capabilities: {
          alwaysMatch: {
            platformName: 'iOS',
            'appium:deviceName': 'Apple iPhone 13',
          },
        },
      });
    } finally {
      await runtime.leaseLifecycle.release?.(lease);
      await runtime.shutdown();
    }
  });
});

test('BrowserStack iOS snapshot reaches one shared presenter and public daemon output', async () => {
  await withProviderScenarioResource(
    () => ProviderRegressionServer.start('ios'),
    async (server) => {
      const runtimes = createProviderWebDriver({
        clientVersion: PROVIDER_REGRESSION_CLIENT_VERSION,
        runHostCommand: unexpectedHostCommand,
      }).createDefaultRuntimes({
        BROWSERSTACK_USERNAME: 'user',
        BROWSERSTACK_ACCESS_KEY: 'key',
        BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
      });
      const providers = createProviderDeviceRuntimeRequestProviders(runtimes);
      const daemon = await createProviderScenarioHarness({
        ...providers,
        deviceInventorySource: providers.deviceInventorySource!,
        platformRuntime: {
          providerRuntimes: runtimes,
          providerModules: runtimes.map((runtime) =>
            Object.freeze({ runtime, module: runtime.platformRuntimeModule }),
          ),
        },
      });
      const present = vi.spyOn(iosSnapshotRuntime, 'presentIosSnapshotAcquisition');
      let lease: DeviceLease | undefined;
      try {
        const allocation = assertRpcOk<{ lease: DeviceLease }>(
          await daemon.callCommand('lease_allocate', [], browserStackIosFlags(), {
            meta: browserStackIosMeta(),
          }),
        );
        lease = allocation.lease;
        assertRpcOk(
          await daemon.callCommand(
            'open',
            ['com.example.demo'],
            browserStackIosFlags(lease.leaseId),
            {
              meta: browserStackIosMeta(lease.leaseId),
            },
          ),
        );
        const result = assertRpcOk<CaptureSnapshotResult>(
          await daemon.callCommand('snapshot', [], browserStackIosFlags(lease.leaseId), {
            meta: browserStackIosMeta(lease.leaseId),
          }),
        );

        assert.equal(present.mock.calls.length, 1);
        assert.equal(present.mock.calls[0]?.[0].acquisition.producer, 'appium-source');
        assert.equal(server.calls.filter((call) => call.path.endsWith('/source')).length, 1);
        assert.deepEqual(
          result.nodes?.map((node) => [node.type, node.label]),
          [
            ['XCUIElementTypeApplication', 'Demo'],
            ['XCUIElementTypeButton', 'Continue'],
          ],
        );
        assert.equal(
          result.nodes?.every((node) => typeof node.ref === 'string'),
          true,
        );
        assert.equal(result.truncated, undefined);
        assert.deepEqual(result.warnings, [
          'iOS snapshot acquisition does not provide hittability evidence; regular snapshots omit unverified hittability while raw snapshots preserve supplied facts.',
          'iOS snapshot acquisition does not report hierarchy completeness; provider-side depth or child limits may omit nodes.',
          'iOS snapshot acquisition does not expose truncation metadata; tree completeness is not independently verified.',
        ]);
      } finally {
        present.mockRestore();
        if (lease) {
          await daemon.callCommand('lease_release', [], browserStackIosFlags(lease.leaseId), {
            meta: browserStackIosMeta(lease.leaseId),
          });
        }
        await daemon.close();
        await Promise.allSettled(runtimes.map(async (runtime) => await runtime.shutdown()));
      }
    },
  );
});

const unexpectedHostCommand: RunHostCommand = async () => {
  throw new Error('unexpected host command');
};

function browserStackIosFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'ios',
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    device: 'iPhone 15',
    providerApp: 'bs://preuploaded',
    providerOsVersion: '17.0',
    providerProject: 'agent-device',
    providerBuild: 'run-a',
    providerSessionName: leaseId,
  };
}

function browserStackIosMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'ios-instance',
    leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    deviceKey: 'webdriver-ios-a',
    clientId: 'client-a',
  };
}
