import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { WebDriverTransport, isWebDriverRequestTimeout } from './webdriver-transport.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// The transport's own deadline must surface as a machine-readable reason, not
// as fetch's `AbortError`/`TimeoutError` DOMException name: the session manager
// keys its "the provider may still be creating a billed session" branch on
// `details.reason`, and a name-sniffing consumer would confuse it with a
// caller-driven cancellation (#1774).
test('a transport-deadline abort surfaces as a typed timeout, not a DOMException name', async () => {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30, retryAttempts: 0 },
  });
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });

  await assert.rejects(transport.requestValue('POST', '/session', {}), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.ok(isWebDriverRequestTimeout(error));
    assert.equal(error.details?.timeoutMs, 30);
    assert.equal(error.details?.method, 'POST');
    assert.equal(error.details?.path, '/session');
    return true;
  });
});

// A caller that cancels its own request keeps a caller-cancellation error —
// only the transport's deadline becomes a typed timeout. Otherwise a client
// disconnect during `POST /session` would read as a provider timeout and drive
// the wrong ownership branch.
test('a caller-driven abort is NOT reclassified as a transport timeout', async () => {
  const controller = new AbortController();
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30_000, retryAttempts: 0 },
  });
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });

  const pending = transport.requestValue('POST', '/session', {}, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('client disconnected'));

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(isWebDriverRequestTimeout(error), false);
    return /client disconnected/.test(error instanceof Error ? error.message : String(error));
  });
});

test('cancels a retry delay when the request binding aborts', async () => {
  const controller = new AbortController();
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30_000, retryAttempts: 1, retryDelayMs: 10_000 },
  });
  let calls = 0;
  let firstRequestObserved!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    firstRequestObserved = resolve;
  });
  globalThis.fetch = async () => {
    calls += 1;
    firstRequestObserved();
    return new Response(JSON.stringify({ value: { message: 'grid unavailable' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const pending = transport.requestValue('GET', '/session/wd-1/source', undefined, {
    signal: controller.signal,
  });
  await firstRequest;
  // Let the failed response enter the retry sleep; aborting before retry policy
  // sees the 503 correctly preserves that primary transport failure instead.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error('request cancelled during WebDriver retry'));

  await assert.rejects(pending, /abort|cancel/i);
  assert.equal(calls, 1);
});
