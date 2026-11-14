import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';
import { deployRevylApp } from './deployment.ts';
import { revylSessionIdForLease } from './session-identity.ts';

const openBackends: RevylFixtureBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

const UPLOAD_PATH = '/api/storage/put';
/** The host environment the packer runs `tar` with. */
const ENV = { PATH: '/usr/bin:/bin' };
const DOWNLOAD_URL = 'https://storage.test/session-build';

/** A backend whose session accepts one upload and reports the install with `result`. */
async function installingBackend(result: Record<string, unknown>, status = 'completed') {
  const sessionId = revylSessionIdForLease('lease-1');
  let backendUrl = '';
  const fixture = await startRevylFixtureBackend({
    respond: {
      [`POST /api/v1/execution/device-sessions/${sessionId}/artifacts/upload-url`]: () => ({
        body: { upload_url: `${backendUrl}${UPLOAD_PATH}`, download_url: DOWNLOAD_URL },
      }),
      [`PUT ${UPLOAD_PATH}`]: { body: {} },
      'POST /api/v1/execution/device-proxy/run-1/install_async': {
        body: { install_id: 'install-1', status: 'accepted' },
      },
      'GET /api/v1/execution/device-proxy/run-1/install_status/install-1': {
        body: { install_id: 'install-1', status, result },
      },
    },
  });
  backendUrl = fixture.backendUrl;
  openBackends.push(fixture);
  const runtime = fixture.createRuntime();
  return { fixture, runtime };
}

async function liveSession(
  runtime: Awaited<ReturnType<typeof installingBackend>>['runtime'],
  platform: 'ios' | 'android',
) {
  await runtime.leaseLifecycle?.allocate?.(revylLease(platform));
  const device = (
    await runtime.deviceInventoryProvider?.({
      leaseProvider: 'revyl',
      leaseId: 'lease-1',
      platform,
    })
  )?.[0];
  if (!device) throw new Error('Expected the live session to be listed.');
  const session = runtime.getDeploymentSession(device);
  if (!session) throw new Error('Expected a live deployment session.');
  return { device, session };
}

test('an Android install uploads the apk to the session and installs it from there', async () => {
  const { fixture, runtime } = await installingBackend({
    success: true,
    package_name: 'com.example.app',
  });
  const { session } = await liveSession(runtime, 'android');
  const dir = await mkdtempForTest('revyl-deploy-');
  const apk = path.join(dir, 'app-debug.apk');
  await fs.writeFile(apk, 'apk-bytes');

  const result = await deployRevylApp(session, apk, ENV, new AbortController().signal);

  assert.deepEqual(result, { packageName: 'com.example.app', launchTarget: 'com.example.app' });
  assert.deepEqual(fixture.bodyFor('upload-url'), {
    file_size: 9,
    content_type: 'application/vnd.android.package-archive',
  });
  const upload = fixture.requests.find((request) => request.path === UPLOAD_PATH);
  assert.equal(upload?.method, 'PUT');
  // The presigned URL carries its own authorization; the API key never goes to storage.
  assert.equal(upload?.authorization, undefined);
  assert.deepEqual(fixture.bodyFor('install_async'), {
    app_url: DOWNLOAD_URL,
    platform: 'android',
  });
});

test('an iOS simulator .app directory is packed before it is uploaded', async () => {
  const { fixture, runtime } = await installingBackend({
    success: true,
    bundle_id: 'com.example.app',
  });
  const { session } = await liveSession(runtime, 'ios');
  const dir = await mkdtempForTest('revyl-deploy-');
  const app = path.join(dir, 'Example.app');
  await fs.mkdir(app);
  await fs.writeFile(path.join(app, 'Info.plist'), 'plist');

  const result = await deployRevylApp(session, app, ENV, new AbortController().signal);

  assert.deepEqual(result, { bundleId: 'com.example.app', launchTarget: 'com.example.app' });
  assert.equal(fixture.bodyFor('upload-url').content_type, 'application/gzip');
});

test('a build Revyl cannot install on the platform is refused before anything is uploaded', async () => {
  const { fixture, runtime } = await installingBackend({ success: true });
  const { session } = await liveSession(runtime, 'ios');
  const dir = await mkdtempForTest('revyl-deploy-');
  const ipa = path.join(dir, 'Example.ipa');
  await fs.writeFile(ipa, 'ipa');

  await assert.rejects(
    () => deployRevylApp(session, ipa, ENV, new AbortController().signal),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'unsupported_app_artifact',
  );
  assert.equal(
    fixture.paths().some((request) => request.includes('upload-url')),
    false,
  );
});

test('an install the worker reports as failed is an error that carries its reason', async () => {
  const { runtime } = await installingBackend(
    { success: false, error: 'not a simulator build' },
    'failed',
  );
  const { session } = await liveSession(runtime, 'android');
  const dir = await mkdtempForTest('revyl-deploy-');
  const apk = path.join(dir, 'app.apk');
  await fs.writeFile(apk, 'apk');

  await assert.rejects(
    () => deployRevylApp(session, apk, ENV, new AbortController().signal),
    (error: unknown) =>
      error instanceof AppError && error.details?.providerDetail === 'not a simulator build',
  );
});

test('an install that outlasts its budget reports an unconfirmed install, not a hang', async () => {
  const { runtime } = await installingBackend({}, 'running');
  const { session } = await liveSession(runtime, 'android');
  const dir = await mkdtempForTest('revyl-deploy-');
  const apk = path.join(dir, 'app.apk');
  await fs.writeFile(apk, 'apk');

  await assert.rejects(
    () => deployRevylApp(session, apk, ENV, new AbortController().signal, 200),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-unconfirmed',
  );
});

test('a canceled install reports the cancellation', async () => {
  const { runtime } = await installingBackend({}, 'running');
  const { session } = await liveSession(runtime, 'android');
  const dir = await mkdtempForTest('revyl-deploy-');
  const apk = path.join(dir, 'app.apk');
  await fs.writeFile(apk, 'apk');
  const controller = new AbortController();

  const install = deployRevylApp(session, apk, ENV, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    () => install,
    (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
  );
});
