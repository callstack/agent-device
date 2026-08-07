import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { WebDriverClient } from './webdriver-client.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// #1658: `fill` blind-settles and types when the keyboard route is unsupported.
// Anything else reaching that branch would degrade a real provider failure into
// a blind text entry, so the split is pinned against the actual wire shapes.
test('is_keyboard_shown reports an unimplemented route as unsupported', async () => {
  // Appium's own answer for a route the driver does not have.
  const client = await connectedClient(
    webDriverResponse(404, { value: { error: 'unknown command', message: 'Unknown command' } }),
  );

  assert.equal(await client.isKeyboardShown(), 'unsupported');
});

test('is_keyboard_shown reports a non-boolean answer as unsupported', async () => {
  const client = await connectedClient(webDriverResponse(200, { value: null }));

  assert.equal(await client.isKeyboardShown(), 'unsupported');
});

// The status is identical to an unimplemented route's, so a status-only test
// would read a dead session as a missing feature and keep typing into it.
test('is_keyboard_shown propagates a dead session, which shares the 404', async () => {
  const client = await connectedClient(
    webDriverResponse(404, {
      value: {
        error: 'invalid session id',
        message: 'A session is either terminated or not started',
      },
    }),
  );

  await assert.rejects(client.isKeyboardShown(), (error: AppError) => {
    assert.match(error.message, /terminated or not started/);
    return true;
  });
});

test('is_keyboard_shown propagates a grid failure', async () => {
  const client = await connectedClient(
    webDriverResponse(503, { value: { message: 'provider backend unavailable' } }),
  );

  await assert.rejects(client.isKeyboardShown(), (error: AppError) => {
    assert.match(error.message, /provider backend unavailable/);
    return true;
  });
});

// The readiness poll advertises a 2s budget; without the override each probe
// would inherit the client's 30s default and one hung request could hold it
// there. A stub that answers only the abort proves the caller's bound is the
// one in force — were it ignored, this test would hang to its own timeout.
test('is_keyboard_shown honors a caller timeout shorter than the client default', async () => {
  const client = await connectedClient(
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      }),
  );

  await assert.rejects(client.isKeyboardShown(50), (error: Error) => {
    assert.match(`${error.name} ${error.message}`, /timeout|abort/i);
    return true;
  });
});

/** A client with a live session id, so `isKeyboardShown` reaches the session route. */
async function connectedClient(respond: typeof globalThis.fetch): Promise<WebDriverClient> {
  globalThis.fetch = webDriverResponse(200, {
    value: { sessionId: 'wd-1', capabilities: {} },
  });
  const client = new WebDriverClient({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30_000, retryAttempts: 0 },
  });
  await client.createSession({ platformName: 'iOS' });
  globalThis.fetch = respond;
  return client;
}

function webDriverResponse(status: number, body: unknown): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}
