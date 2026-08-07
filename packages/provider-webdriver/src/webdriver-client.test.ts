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

// The focused element is the only signal that can say WHICH field took focus,
// so `fill` fails closed when it is unavailable. Each wire shape it
// distinguishes is pinned here.
test('activeElement returns the focused element id and rect', async () => {
  const client = await connectedClient(
    webDriverRoutes({
      '/element/active': { body: { value: { [W3C_ELEMENT_KEY]: 'el-1' } } },
      '/rect': { body: { value: { x: 20, y: 300, width: 350, height: 44 } } },
    }),
  );

  assert.deepEqual(await client.activeElement(), {
    id: 'el-1',
    rect: { x: 20, y: 300, width: 350, height: 44 },
  });
});

// A form with nothing focused yet is an expected state, not a broken driver —
// the caller must keep polling rather than give up.
test('activeElement reports nothing focused as none', async () => {
  const client = await connectedClient(
    webDriverRoutes({
      '/element/active': {
        status: 404,
        body: { value: { error: 'no such element', message: 'nothing focused' } },
      },
    }),
  );

  assert.equal(await client.activeElement(), 'none');
});

// Focus moved between the two round trips. A race the caller can simply retry
// out of, not a failure worth ending the fill on.
test('activeElement reports an element that vanished before its rect as none', async () => {
  const client = await connectedClient(
    webDriverRoutes({
      '/element/active': { body: { value: { [W3C_ELEMENT_KEY]: 'el-1' } } },
      '/rect': {
        status: 404,
        body: { value: { error: 'no such element', message: 'stale element' } },
      },
    }),
  );

  assert.equal(await client.activeElement(), 'none');
});

// A grid that answers 200/null is not implementing the route: the spec reports
// "nothing focused" as a `no such element` error. Reading null as "nothing
// focused" would fail every fill on such a grid instead of falling back.
test('activeElement reports a non-element answer as unsupported', async () => {
  const client = await connectedClient(
    webDriverRoutes({ '/element/active': { body: { value: null } } }),
  );

  assert.equal(await client.activeElement(), 'unsupported');
});

test('activeElement reports an unimplemented route as unsupported', async () => {
  const client = await connectedClient(
    webDriverRoutes({
      '/element/active': {
        status: 404,
        body: { value: { error: 'unknown command', message: 'Unknown command' } },
      },
    }),
  );

  assert.equal(await client.activeElement(), 'unsupported');
});

// Same discipline as the keyboard route: a dead session shares the 404 and must
// never be mistaken for a driver that simply lacks the feature.
test('activeElement propagates a dead session, which shares the 404', async () => {
  const client = await connectedClient(
    webDriverRoutes({
      '/element/active': {
        status: 404,
        body: {
          value: { error: 'invalid session id', message: 'A session is either terminated' },
        },
      },
    }),
  );

  await assert.rejects(client.activeElement(), (error: AppError) => {
    assert.match(error.message, /terminated/);
    return true;
  });
});

// `timeoutMs` bounds the OPERATION, not each request in it. Given the full
// budget twice, these two sequential round trips would together take double it
// — a probe handed the 1.5s left of a 2s readiness deadline would run 3s and
// overrun the deadline it came from. Real time is unavoidable here: the defect
// IS elapsed transport time across two calls.
test('activeElement bounds its two sequential requests by one shared budget', async () => {
  const firstCallMs = 80;
  const budgetMs = 200;
  let rectRequestBudgetMs: number | undefined;
  const client = await connectedClient(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/rect')) {
      // Never answers; only its own abort ends it, so how long it was allowed
      // to run is exactly the budget it was handed.
      const startedAt = Date.now();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          rectRequestBudgetMs = Date.now() - startedAt;
          reject(init.signal?.reason as Error);
        });
      });
    }
    await new Promise((resolve) => setTimeout(resolve, firstCallMs));
    return new Response(JSON.stringify({ value: { [W3C_ELEMENT_KEY]: 'el-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await assert.rejects(client.activeElement(budgetMs));

  assert.ok(rectRequestBudgetMs !== undefined, 'the rect request should have been made');
  // It must get what the first call left (~120ms), never a fresh 200ms.
  assert.ok(
    rectRequestBudgetMs < budgetMs - firstCallMs / 2,
    `rect request was allowed ${rectRequestBudgetMs}ms of a shared ${budgetMs}ms budget already ${firstCallMs}ms spent`,
  );
});

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** Dispatches by URL suffix, since `activeElement` makes two round trips. */
function webDriverRoutes(
  routes: Record<string, { status?: number; body: unknown }>,
): typeof globalThis.fetch {
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const key = keys.find((candidate) => url.includes(candidate));
    const route = key
      ? routes[key]!
      : { status: 500, body: { value: { message: `unrouted ${url}` } } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/** A client with a live session id, so the probes reach the session routes. */
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
