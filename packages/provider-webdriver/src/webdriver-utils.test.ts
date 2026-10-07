import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { asOptionalRecord } from '@agent-device/kernel/record';
import {
  appendUrlPath,
  appFileUploadForm,
  createHubUploadApp,
  postHubAppUpload,
  readFlag,
  requireEnv,
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

const hub = {
  service: 'Hub',
  endpoint: 'https://upload.example.test/app',
  clientVersion: '0.0.0-test',
  auth: { username: 'user', accessKey: 'key' },
  readAppReference: (body: unknown) => asOptionalRecord(body)?.ref as string | undefined,
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
    new Response(JSON.stringify({ ref: '  ' }), { status: 200 }),
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

const hubReferenceGrammar = {
  parseReference: (app: string) => {
    if (app.slice(0, 6).toLowerCase() !== 'hub://') return undefined;
    const reference = `hub://${app.slice(6)}`;
    if (/^hub:\/\/\w+$/.test(reference)) return reference;
    throw new AppError('INVALID_ARGS', `Hub --provider-app ${app} is not a hub:// app id.`);
  },
};

test('the hub app resolver passes references through, uploads local files, and passes URLs through', async () => {
  const tempDir = await mkdtempForTest('agent-device-hub-resolve-');
  try {
    await fs.writeFile(path.join(tempDir, 'App.apk'), 'placeholder');
    const uploadFile = vi.fn(async (appPath: string) => `hub://${path.basename(appPath)}`);
    const resolve = (app: string) =>
      resolveHubAppReference({
        service: 'Hub',
        app,
        cwd: tempDir,
        referenceLabel: 'a hub:// app id',
        ...hubReferenceGrammar,
        uploadFile,
      });

    assert.equal(await resolve('hub://APP3'), 'hub://APP3');
    assert.equal(await resolve('HUB://APP3'), 'hub://APP3');
    assert.equal(await resolve('https://builds.example/App.apk'), 'https://builds.example/App.apk');
    assert.equal(await resolve('HTTPS://builds.example/App.apk'), 'HTTPS://builds.example/App.apk');
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

test('appFileUploadForm carries a regular app file and refuses anything else typed', async () => {
  const tempDir = await mkdtempForTest('agent-device-upload-form-');
  try {
    const appPath = path.join(tempDir, 'App.ipa');
    const bundlePath = path.join(tempDir, 'App.app');
    const missingPath = path.join(tempDir, 'Missing.ipa');
    await fs.writeFile(appPath, 'ipa bytes');
    await fs.mkdir(bundlePath);
    const hub = { provider: 'hub', service: 'Hub' };

    const file = (await appFileUploadForm(appPath, 'file', hub)).get('file') as File;
    assert.equal(file.name, 'App.ipa');
    assert.equal(await file.text(), 'ipa bytes');

    for (const refusedPath of [bundlePath, missingPath]) {
      await assert.rejects(appFileUploadForm(refusedPath, 'file', hub), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.equal(error.message, `Hub can only upload a regular app file: ${refusedPath}`);
        assert.equal(error.details?.provider, 'hub');
        assert.equal(error.details?.appPath, refusedPath);
        return true;
      });
    }
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

test('the hub app resolver surfaces the grammar rejection of a malformed reference without uploading', async () => {
  const tempDir = await mkdtempForTest('agent-device-hub-resolve-invalid-');
  try {
    const uploadFile = vi.fn(async () => 'hub://never');
    const resolve = (app: string) =>
      resolveHubAppReference({
        service: 'Hub',
        app,
        cwd: tempDir,
        referenceLabel: 'a hub:// app id',
        ...hubReferenceGrammar,
        uploadFile,
      });

    for (const [app, message] of [
      ['hub://', /^Hub --provider-app hub:\/\/ is not a hub:\/\/ app id\.$/],
      ['HUB://a b', /is not a hub:\/\/ app id/],
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

test('a whitespace-only credential is missing', () => {
  assert.equal(requireEnv({ USER: 'u' }, 'USER', 'Hub'), 'u');
  for (const env of [{}, { USER: '' }, { USER: ' \t' }]) {
    assert.throws(
      () => requireEnv(env, 'USER', 'Hub'),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message === 'Hub requires USER in the environment.',
    );
  }
});

test('only non-empty string flags are read', () => {
  const req = { flags: { device: 'Pixel 8', empty: '', count: 3 } };
  assert.equal(readFlag(req, 'device'), 'Pixel 8');
  assert.equal(readFlag(req, 'empty'), undefined);
  assert.equal(readFlag(req, 'count'), undefined);
});

test.skipIf(process.platform === 'win32')(
  'appFileUploadForm refuses a named pipe without reading it',
  async () => {
    const tempDir = await mkdtempForTest('agent-device-upload-form-fifo-');
    try {
      const fifoPath = path.join(tempDir, 'App.ipa');
      await runCmd('mkfifo', [fifoPath]);

      await assert.rejects(
        appFileUploadForm(fifoPath, 'file', { provider: 'hub', service: 'Hub' }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'INVALID_ARGS');
          assert.equal(error.message, `Hub can only upload a regular app file: ${fifoPath}`);
          assert.equal(error.details?.appPath, fifoPath);
          return true;
        },
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);
