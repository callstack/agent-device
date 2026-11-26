import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverRuntime } from '@agent-device/provider-webdriver/plugin';
import { createSauceLabsWebDriver } from './saucelabs-webdriver.ts';
import createSession from './fixtures/create-session-android.json' with { type: 'json' };
import jobRunning from './fixtures/job-running.json' with { type: 'json' };
import jobEnded from './fixtures/job-ended.json' with { type: 'json' };

const FILE_ID = '0b6a3f52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const JOB_ID = '0123456789abcdef0123456789abcdef';
const HUB = 'https://ondemand.eu-central-1.saucelabs.com/wd/hub';
const API = 'https://api.eu-central-1.saucelabs.com';

afterEach(() => vi.unstubAllGlobals());

function host(env: Record<string, string>): ProviderPluginHost {
  return {
    env: { SAUCE_USERNAME: 'user', SAUCE_ACCESS_KEY: 'key', ...env },
    options: {},
    clientVersion: '1.2.3',
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

const LEASE = {
  leaseId: 'lease-1',
  tenantId: 'team-a',
  runId: 'run-1',
  clientId: 'client-a',
  leaseProvider: 'saucelabs',
  backend: 'android-instance',
  deviceKey: 'saucelabs:device-a',
  createdAt: 1,
  expiresAt: 2,
  heartbeatAt: 1,
} as DeviceLease;

/** A hub and job API that answer with the recorded live responses; `job.ended` flips the job. */
function stubSauceLabs() {
  const job = { ended: false };
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        url,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (url === `${HUB}/session` && method === 'POST') return json(createSession);
      if (url.startsWith(`${HUB}/session/`) && method === 'DELETE') return json({ value: null });
      if (url === `${API}/v1/rdc/jobs/${JOB_ID}`) return json(job.ended ? jobEnded : jobRunning);
      return json({ value: { error: 'unknown route', message: url } }, 404);
    }),
  );
  return { job, requests };
}

test('a session runs at the SAUCE_REGION hub, reports the allocated device, and is keyed by its job id', async () => {
  const { job, requests } = stubSauceLabs();
  const runtime = await createCloudWebDriverRuntime({
    ...createSauceLabsWebDriver(host({ SAUCE_REGION: 'eu-central-1' })),
    clientVersion: '1.2.3',
    requestPolicy: { retryAttempts: 0 },
  });

  try {
    const allocated = await runtime.leaseLifecycle.allocate!(LEASE, {
      flags: {
        platform: 'android',
        device: 'Google Pixel.*',
        providerApp: `storage:${FILE_ID}`,
        providerSessionName: 'checkout',
      },
    });
    assert.equal(allocated?.providerSessionId, JOB_ID);
    const create = requests.find((request) => request.method === 'POST');
    assert.ok(create);
    const capabilities = (create.body as { capabilities: { alwaysMatch: Record<string, unknown> } })
      .capabilities.alwaysMatch;
    assert.equal(capabilities['appium:deviceName'], 'Google Pixel.*');
    assert.deepEqual(capabilities['sauce:options'], {
      name: 'checkout',
      build: 'run-1',
      appiumVersion: 'latest',
      sessionCreationTimeout: 100_000,
      sessionCreationRetry: 0,
    });
    const [device] =
      (await runtime.deviceInventoryProvider({
        leaseProvider: 'saucelabs',
        leaseId: LEASE.leaseId,
      } as never)) ?? [];
    // Commands select the device by the requested name; the allocated device is its model.
    assert.equal(device?.name, 'Google Pixel.*');
    assert.equal(device?.model, 'Google Pixel 8 (Google_Pixel_8_15_real)');

    // At release the job is still running: the dashboard link is there, media still pending.
    const released = (await runtime.leaseLifecycle.release!(LEASE)) as {
      providerSessionId: string;
      cloudArtifacts: { status: string; cloudArtifacts: Array<{ kind: string }> };
    };
    assert.equal(released.providerSessionId, JOB_ID);
    assert.equal(released.cloudArtifacts.status, 'pending');
    assert.deepEqual(
      released.cloudArtifacts.cloudArtifacts.map(({ kind }) => kind),
      ['provider-session'],
    );

    job.ended = true;
    const after = await runtime.cloudArtifacts?.listCloudArtifacts?.({
      provider: 'saucelabs',
      leaseId: LEASE.leaseId,
    });
    assert.equal(after?.status, 'ready');
    assert.deepEqual(
      after?.cloudArtifacts.map(({ kind }) => kind),
      ['video', 'appium-log', 'device-log', 'automation-log', 'provider-session'],
    );
    assert.ok(requests.some((request) => request.method === 'DELETE'));
  } finally {
    await runtime.shutdown();
  }
});

test('the runtime-wide lookup reads a job id alone from the SAUCE_REGION data center', async () => {
  const { job, requests } = stubSauceLabs();
  job.ended = true;
  const webDriver = createSauceLabsWebDriver(host({ SAUCE_REGION: 'eu-central-1' }));
  const result = await webDriver.listArtifacts!({
    provider: 'saucelabs',
    providerSessionId: JOB_ID,
  });
  assert.equal(result?.status, 'ready');
  assert.deepEqual(
    requests.map(({ url }) => url),
    [`${API}/v1/rdc/jobs/${JOB_ID}`],
  );
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
