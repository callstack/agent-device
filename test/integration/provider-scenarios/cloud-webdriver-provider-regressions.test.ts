import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  createProviderWebDriver,
  type RunHostCommand,
} from '@agent-device/provider-webdriver';
import { withProviderScenarioResource, withProviderScenarioTempDir } from './harness.ts';
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

test('WebDriver session creation retries transient provider failures', async () => {
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
      const allocation = await runtime.leaseLifecycle.allocate?.(
        lease,
        browserStackRegressionContext(),
      );
      assert.equal(allocation?.providerSessionId, 'wd-regression');
      assert.equal(server.calls.filter((call) => call.path === '/wd/hub/session').length, 2);
    } finally {
      await runtime.leaseLifecycle.release?.(lease);
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

const unexpectedHostCommand: RunHostCommand = async () => {
  throw new Error('unexpected host command');
};
