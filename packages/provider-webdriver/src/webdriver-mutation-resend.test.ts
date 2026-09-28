import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import { WebDriverClient } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A grid that answers `POST /session` immediately, then never answers the one
 * configured mutating route until the transport's own request timeout aborts
 * it. Every other route answers immediately with an empty value. This is the
 * shape a hung `POST .../actions` or `.../keys` takes on a real provider: the
 * driver received the request and is still working it, not a connection
 * failure.
 */
function hangingWebDriverFetch(hangOnPathSuffix: string): {
  fetch: typeof globalThis.fetch;
  callsFor: (pathSuffix: string) => number;
} {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith('/session')) {
      return new Response(JSON.stringify({ value: { sessionId: 'wd-1', capabilities: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname.endsWith(hangOnPathSuffix)) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    }
    return new Response(JSON.stringify({ value: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, callsFor: (pathSuffix) => paths.filter((p) => p.endsWith(pathSuffix)).length };
}

/**
 * A real `WebDriverClient` and `createWebDriverInteractor`, connected through
 * a driver that hangs on `hangOnPathSuffix`. `timeoutMs` is the smallest the
 * transport accepts that still lets `AbortSignal.timeout` and the fetch stub's
 * abort listener race deterministically; `retryDelayMs` is cut to keep a
 * retried attempt's sleep out of the test budget.
 */
async function connectedWebDriverInteractor(hangOnPathSuffix: string) {
  const { fetch, callsFor } = hangingWebDriverFetch(hangOnPathSuffix);
  globalThis.fetch = fetch;
  const client = new WebDriverClient({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 20, retryDelayMs: 5 },
  });
  await client.createSession({ platformName: 'Android' });
  const interactor = createWebDriverInteractor({
    client,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  return { interactor, callsFor };
}

// A tap whose `POST .../actions` request times out gets exactly one attempt:
// a resend cannot tell whether the touch the driver is still processing from
// the first attempt already landed, so a second attempt risks a doubled
// gesture instead of a safe no-op. The thrown error still discloses that the
// outcome is unresolved via `details.dispatched`.
test('a timed-out tap is never resent', async () => {
  const { interactor, callsFor } = await connectedWebDriverInteractor('/actions');

  await assert.rejects(interactor.tap(10, 20), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.dispatched, 'unknown');
    return true;
  });

  assert.equal(callsFor('/actions'), 1);
});

// Same shape for text entry: a hung `POST .../keys` must not be resent, or a
// doubled key stream could reach the field the first attempt already typed
// into.
test('timed-out keys are never resent', async () => {
  const { interactor, callsFor } = await connectedWebDriverInteractor('/keys');

  await assert.rejects(interactor.type('hello'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.dispatched, 'unknown');
    return true;
  });

  assert.equal(callsFor('/keys'), 1);
});

// A third mutating route, distinct from the gesture/text-entry paths: a hung
// `POST .../back` must not be resent, or a doubled back navigation could
// leave the app a screen further back than the caller asked for.
test('a timed-out back is never resent', async () => {
  const { interactor, callsFor } = await connectedWebDriverInteractor('/back');

  await assert.rejects(interactor.back(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.dispatched, 'unknown');
    return true;
  });

  assert.equal(callsFor('/back'), 1);
});

// The mutation policy is narrowly scoped: a read route (page source) keeps
// the transport's default retry budget, so a timeout there still resends
// once, exactly as it did before this change.
test('a timed-out read is still retried once', async () => {
  const { interactor, callsFor } = await connectedWebDriverInteractor('/source');

  await assert.rejects(interactor.snapshot(), () => true);

  assert.equal(callsFor('/source'), 2);
});
