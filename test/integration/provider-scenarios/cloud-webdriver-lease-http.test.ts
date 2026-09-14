import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  createProviderWebDriver,
} from '@agent-device/provider-webdriver';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import { buildHttpRpcPayload } from '../../../src/daemon-client/daemon-client-rpc.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  cloudWebDriverTestJson,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
} from './cloud-webdriver-test-server.ts';

const CLIENT_VERSION = '0.20.3-test';

/**
 * The lease envelope is a hand-written projection, so a field the provider needs can be dropped
 * silently on the HTTP transport while the line transport forwards it for free. This drives the
 * exact client envelope through a real daemon HTTP server into the real BrowserStack
 * `prepareSession`, and asserts the capabilities that reach the hub — the only seam that proves a
 * fresh remote allocation actually names and configures the session.
 */
test('lease_allocate over HTTP prepares the BrowserStack session end to end', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'BrowserStack lease HTTP coverage')) {
    return;
  }

  await withProviderScenarioResource(FakeBrowserStackServer.start, async (server) => {
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
    const providerModules = runtimes.map((runtime) =>
      Object.freeze({ runtime, module: runtime.platformRuntimeModule }),
    );
    const harness = await createProviderScenarioHarness({
      ...providers,
      deviceInventorySource: providers.deviceInventorySource!,
      platformRuntime: { providerRuntimes: runtimes, providerModules },
    });
    const httpServer = await createDaemonHttpServer({
      token: harness.token,
      handleRequest: harness.handleRequest,
    });

    try {
      const port = await listenOnLoopback(httpServer);
      const envelope = buildHttpRpcPayload(
        {
          token: harness.token,
          session: 'browserstack-e2e',
          command: 'lease_allocate',
          positionals: [],
          flags: {
            platform: 'android',
            device: 'Google Pixel 8',
            providerApp: 'bs://preuploaded',
            providerOsVersion: '14.0',
            providerProject: 'MyProject',
            providerBuild: 'Build-2026-09-11',
            providerSessionName: 'smoke',
            providerDeviceOrientation: 'portrait',
          },
          meta: {
            tenantId: 'team-a',
            runId: 'run-a',
            leaseBackend: 'android-instance',
            leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
            deviceKey: 'webdriver-android-a',
            clientId: 'client-a',
          },
        },
        { includeTokenParam: false },
      );

      const body = await postRpc(port, harness.token, envelope);
      assert.equal(body.status, 200);
      assert.equal(body.rpc.error, undefined, `rpc error: ${JSON.stringify(body.rpc.error)}`);
      assert.ok(
        body.rpc.result?.ok === true,
        `daemon rejected allocate: ${JSON.stringify(body.rpc.result ?? body.rpc)}`,
      );

      const create = server.calls.find((call) => call.path === '/wd/hub/session');
      assert.ok(create, 'provider never received a session-create call');
      assert.deepEqual(alwaysMatch(create), {
        platformName: 'Android',
        'appium:deviceName': 'Google Pixel 8',
        device: 'Google Pixel 8',
        os_version: '14.0',
        app: 'bs://preuploaded',
        'bstack:options': {
          projectName: 'MyProject',
          buildName: 'Build-2026-09-11',
          sessionName: 'smoke',
          deviceOrientation: 'portrait',
        },
      });
    } finally {
      await closeLoopbackServer(httpServer);
      await harness.close();
      await Promise.allSettled(runtimes.map(async (runtime) => await runtime.shutdown()));
    }
  });
}, 15_000);

/**
 * The provider fake hijacks `globalThis.fetch`, so the daemon RPC is spoken over a real
 * `node:http` request instead — the same wire a remote client uses, without colliding with the
 * intercepted provider transport.
 */
function postRpc(
  port: number,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; rpc: RpcEnvelope }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            rpc: JSON.parse(text) as RpcEnvelope,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(payload));
  });
}

type RpcEnvelope = {
  result?: { ok?: boolean; error?: { message?: string } };
  error?: { message?: string };
};

function alwaysMatch(call: CloudWebDriverHttpCall): Record<string, unknown> | undefined {
  return (call.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } } | undefined)
    ?.capabilities?.alwaysMatch;
}

class FakeBrowserStackServer extends CloudWebDriverTestServer {
  static async start(): Promise<StartedCloudWebDriverTestServer<FakeBrowserStackServer>> {
    return await startCloudWebDriverTestServer(new FakeBrowserStackServer());
  }

  protected respond(call: CloudWebDriverHttpCall) {
    if (call.method === 'POST' && call.path === '/wd/hub/session') {
      return cloudWebDriverTestJson({
        value: { sessionId: 'wd-1', capabilities: { platformName: 'Android' } },
      });
    }
    return cloudWebDriverTestJson({ value: null });
  }
}
