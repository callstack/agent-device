import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  appendUrlPath,
  asRecord,
  createHubUploadApp,
  fetchProviderVerificationJson,
  postHubAppUpload,
  resolveHubAppReference,
  trimLeadingSlash,
  trimTrailingSlash,
} from './webdriver-utils.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('slash trimming utilities handle slash-heavy strings without regular expressions', () => {
  const slashRun = '/'.repeat(10_000);

  assert.equal(trimLeadingSlash(`${slashRun}wd/hub`), 'wd/hub');
  assert.equal(
    trimTrailingSlash(`https://example.test/wd/hub${slashRun}`),
    'https://example.test/wd/hub',
  );
  assert.equal(trimLeadingSlash('wd/hub'), 'wd/hub');
  assert.equal(trimTrailingSlash('https://example.test/wd/hub'), 'https://example.test/wd/hub');
  assert.equal(trimLeadingSlash(slashRun), '');
  assert.equal(trimTrailingSlash(slashRun), '');
});

test('asRecord admits plain objects only', () => {
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.equal(asRecord([]), undefined);
  assert.equal(asRecord(null), undefined);
  assert.equal(asRecord('x'), undefined);
});

const hub = {
  service: 'Hub',
  endpoint: 'https://upload.example.test/app',
  clientVersion: '0.0.0-test',
  auth: { username: 'user', accessKey: 'key' },
  readAppReference: (body: unknown) => asRecord(body)?.ref as string | undefined,
};

test('the hub upload helper posts with credentials and returns the vendor reference', async () => {
  const form = new FormData();
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), hub.endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, form);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Basic ${Buffer.from('user:key').toString('base64')}`);
    assert.equal(headers['x-agent-device-version'], '0.0.0-test');
    return new Response(JSON.stringify({ ref: 'hub://APP1' }), { status: 200 });
  };
  assert.equal(await postHubAppUpload(form, hub), 'hub://APP1');
});

test('the hub upload helper fails typed with the status on an error page or a missing reference', async () => {
  for (const response of [
    new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    new Response(JSON.stringify({ message: 'ok' }), { status: 200 }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(postHubAppUpload(new FormData(), hub), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Hub app upload failed.');
      assert.equal(error.details?.status, response.status);
      return true;
    });
  }
});

test('the hub install adapter uploads the build and launches the hinted app', async () => {
  const upload = vi.fn(async () => 'hub://APP2');
  const signal = new AbortController().signal;
  const result = await createHubUploadApp(upload)({
    appPath: '/builds/App.ipa',
    options: { appIdentifierHint: 'com.example.app' },
    signal,
  });
  assert.deepEqual(upload.mock.calls, [['/builds/App.ipa', signal]]);
  assert.deepEqual(result, {
    appReference: 'hub://APP2',
    bundleId: 'com.example.app',
    packageName: undefined,
    launchTarget: 'com.example.app',
  });
});

test('the hub app resolver passes references through, uploads local files, and routes URLs per hub', async () => {
  const tempDir = await mkdtempForTest('agent-device-hub-resolve-');
  try {
    await fs.writeFile(path.join(tempDir, 'App.apk'), 'placeholder');
    const uploadFile = vi.fn(async (appPath: string) => `hub://${path.basename(appPath)}`);
    const resolve = (app: string, uploadUrl?: (url: string) => Promise<string>) =>
      resolveHubAppReference({
        service: 'Hub',
        app,
        cwd: tempDir,
        referenceScheme: 'hub://',
        referenceLabel: 'a hub:// app id',
        uploadFile,
        uploadUrl,
      });

    assert.equal(await resolve('hub://APP3'), 'hub://APP3');
    assert.equal(await resolve('HUB://APP3'), 'hub://APP3');
    assert.equal(await resolve('https://builds.example/App.apk'), 'https://builds.example/App.apk');
    assert.equal(
      await resolve('https://builds.example/App.apk', async (url) => `fetched:${url}`),
      'fetched:https://builds.example/App.apk',
    );
    assert.equal(await resolve('App.apk'), 'hub://App.apk');
    assert.deepEqual(uploadFile.mock.calls, [[path.join(tempDir, 'App.apk'), undefined]]);
    await assert.rejects(resolve('missing.apk'), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(
        error.message,
        'Hub --provider-app must be a hub:// app id, URL, or existing local app path.',
      );
      return true;
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('the hub app resolver refuses an empty reference and a directory, typed', async () => {
  const tempDir = await mkdtempForTest('agent-device-hub-resolve-invalid-');
  try {
    await fs.mkdir(path.join(tempDir, 'App.app'));
    const uploadFile = vi.fn(async () => 'hub://never');
    const resolve = (app: string) =>
      resolveHubAppReference({
        service: 'Hub',
        app,
        cwd: tempDir,
        referenceScheme: 'hub://',
        referenceLabel: 'a hub:// app id',
        isReference: (reference) => /^hub:\/\/\w+$/.test(reference),
        uploadFile,
      });

    for (const [app, message] of [
      ['hub://', /^Hub --provider-app hub:\/\/ is not a hub:\/\/ app id\.$/],
      ['hub://a b', /is not a hub:\/\/ app id/],
      ['App.app', /must be an app file, not a directory: .*App\.app$/],
    ] as const) {
      await assert.rejects(
        resolve(app),
        (error: unknown) =>
          error instanceof AppError && error.code === 'INVALID_ARGS' && message.test(error.message),
      );
    }
    assert.equal(uploadFile.mock.calls.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('appending a route keeps a query on the base endpoint', () => {
  assert.equal(
    appendUrlPath('https://api.example.test/v1/?region=eu', 'sessions/S%201').toString(),
    'https://api.example.test/v1/sessions/S%201?region=eu',
  );
  assert.equal(
    appendUrlPath('https://api.example.test/v1', 'sessions/S1').toString(),
    'https://api.example.test/v1/sessions/S1',
  );
});

const verificationHints = {
  service: 'Hub',
  unauthorizedHint: 'Check HUB_KEY.',
  serviceHint: 'Retry connect or check the Hub service status.',
  networkHint: 'Check network access to the hub.',
};

test('connection verification reports a non-JSON success typed, with its status', async () => {
  globalThis.fetch = async () => new Response('<html>maintenance</html>', { status: 200 });
  await assert.rejects(
    fetchProviderVerificationJson('https://api.example.test/apps', {
      clientVersion: '0.0.0-test',
      hints: verificationHints,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Hub connection verification answer was not JSON.');
      assert.equal(error.details?.status, 200);
      assert.equal(error.details?.hint, verificationHints.serviceHint);
      return true;
    },
  );
});

test('connection verification gives each failure its provider hint', async () => {
  for (const [status, code, hint] of [
    [401, 'UNAUTHORIZED', verificationHints.unauthorizedHint],
    [503, 'COMMAND_FAILED', verificationHints.serviceHint],
  ] as const) {
    globalThis.fetch = async () => new Response('nope', { status });
    await assert.rejects(
      fetchProviderVerificationJson('https://api.example.test/apps', {
        clientVersion: '0.0.0-test',
        hints: verificationHints,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === code &&
        error.details?.status === status &&
        error.details?.hint === hint,
    );
  }
});
