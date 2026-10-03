import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  listBrowserStackCloudArtifacts,
  resolveBrowserStackAppReference,
  uploadBrowserStackApp,
} from './browserstack.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('BrowserStack upload aborts while the provider request is in flight', async () => {
  const tempDir = await mkdtempForTest('agent-device-browserstack-upload-');
  const appPath = path.join(tempDir, 'App.apk');
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during BrowserStack upload');
  try {
    await fs.writeFile(appPath, 'placeholder');
    globalThis.fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        assert.equal(init?.signal, controller.signal);
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    const pending = uploadBrowserStackApp(
      appPath,
      {
        clientVersion: '0.0.0-test',
        username: 'user',
        accessKey: 'key',
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(abortReason);

    await assert.rejects(pending, (error: unknown) => error === abortReason);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const upload = { clientVersion: '0.0.0-test', username: 'user', accessKey: 'key' };

test('BrowserStack upload sends the file field and fails typed on a gateway error page', async () => {
  const tempDir = await mkdtempForTest('agent-device-browserstack-upload-error-');
  const appPath = path.join(tempDir, 'App.apk');
  try {
    await fs.writeFile(appPath, 'placeholder');
    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.body instanceof FormData);
      assert.ok(init.body.get('file') instanceof Blob);
      return new Response('<html>502 Bad Gateway</html>', { status: 502 });
    };
    await assert.rejects(uploadBrowserStackApp(appPath, upload), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'BrowserStack app upload failed.');
      assert.equal(error.details?.status, 502);
      return true;
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('BrowserStack passes bs:// ids and URLs to the hub and uploads only local paths', async () => {
  const tempDir = await mkdtempForTest('agent-device-browserstack-resolve-');
  try {
    await fs.writeFile(path.join(tempDir, 'App.apk'), 'placeholder');
    const fetched: string[] = [];
    globalThis.fetch = async (input) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ app_url: 'bs://uploaded' }), { status: 200 });
    };
    const resolve = async (app: string) =>
      await resolveBrowserStackAppReference(app, { ...upload, cwd: tempDir });

    assert.equal(await resolve('bs://preuploaded'), 'bs://preuploaded');
    assert.equal(await resolve('https://builds.example/App.apk'), 'https://builds.example/App.apk');
    assert.equal(await resolve('HTTPS://builds.example/App.apk'), 'HTTPS://builds.example/App.apk');
    assert.equal(fetched.length, 0);
    assert.equal(await resolve('App.apk'), 'bs://uploaded');
    assert.deepEqual(fetched, ['https://api-cloud.browserstack.com/app-automate/upload']);
    await assert.rejects(resolve('missing.apk'), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(
        error.message,
        'BrowserStack --provider-app must be a bs:// app id, URL, or existing local app path.',
      );
      return true;
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('BrowserStack session details lookup has a deadline and fails typed', async () => {
  const lookup = async () =>
    await listBrowserStackCloudArtifacts('browserstack', 'SESSION1', upload);
  // The fetch stays pending until the signal the lookup armed aborts, so only the 15 s deadline
  // can end it; without that deadline the timeout spy is never called and the next assert fails.
  const deadline = new AbortController();
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => deadline.signal);
  let started: () => void = () => {};
  const fetchStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      started();
    });
  try {
    const pending = lookup();
    await fetchStarted;
    assert.deepEqual(timeoutSpy.mock.calls, [[15_000]]);
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    deadline.abort(timeout);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'BrowserStack session details lookup failed.');
      assert.equal(error.cause, timeout);
      return true;
    });
  } finally {
    timeoutSpy.mockRestore();
  }

  const networkFailure = new TypeError('fetch failed');
  globalThis.fetch = async () => {
    throw networkFailure;
  };
  await assert.rejects(
    lookup(),
    (error: unknown) => error instanceof AppError && error.cause === networkFailure,
  );

  for (const body of ['<html>gateway</html>', '[]']) {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    await assert.rejects(lookup(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.status, 200);
      return true;
    });
  }
});
