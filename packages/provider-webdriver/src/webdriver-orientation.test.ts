import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import type { WebDriverClient } from './webdriver-client.ts';
import { setWebDriverOrientation } from './webdriver-orientation.ts';
import { WebDriverTransport } from './webdriver-transport.ts';

type Call = { method: string; args: unknown[] };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The error the real transport raises for this driver answer. */
async function driverAnswerError(driver: typeof globalThis.fetch): Promise<unknown> {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 20 },
  });
  globalThis.fetch = driver;
  try {
    await transport.requestValue('POST', '/session/wd-1/rotation', {});
  } catch (error) {
    return error;
  } finally {
    globalThis.fetch = realFetch;
  }
  throw new Error('the driver answer did not fail');
}

function answer(status: number, body: unknown): () => Promise<unknown> {
  return () => driverAnswerError(async () => Response.json(body, { status }));
}

/** A driver answering "I do not implement this route" — the only case that earns a fallback. */
const unsupportedEndpointError = answer(404, {
  value: { error: 'unknown command', message: 'Unknown command' },
});

function makeClient(
  options: { reject?: readonly string[]; rejectWith?: () => Promise<unknown> } = {},
): {
  client: WebDriverClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const reject = new Set(options.reject ?? []);
  const rejectWith = options.rejectWith ?? unsupportedEndpointError;
  const record = (method: string) => {
    return async (...args: unknown[]): Promise<void> => {
      calls.push({ method, args });
      if (reject.has(method)) throw await rejectWith();
    };
  };
  return {
    calls,
    client: {
      setRotation: record('setRotation'),
      setOrientation: record('setOrientation'),
    } as unknown as WebDriverClient,
  };
}

test('android prefers the exact four-way rotation endpoint', async () => {
  const { client, calls } = makeClient();

  await setWebDriverOrientation(client, 'android', 'landscape-right');

  assert.deepEqual(calls, [{ method: 'setRotation', args: [270] }]);
});

test('four-way rotations map onto distinct surface degrees', async () => {
  const degrees: number[] = [];
  for (const rotation of [
    'portrait',
    'landscape-left',
    'portrait-upside-down',
    'landscape-right',
  ] as const) {
    const { client, calls } = makeClient();
    await setWebDriverOrientation(client, 'android', rotation);
    degrees.push(calls[0]?.args[0] as number);
  }
  assert.deepEqual(degrees, [0, 90, 180, 270]);
});

test('xctest leads with the two-way endpoint, since it rejects /rotation', async () => {
  const { client, calls } = makeClient();

  await setWebDriverOrientation(client, 'xctest', 'landscape-left');

  assert.deepEqual(calls, [{ method: 'setOrientation', args: ['LANDSCAPE'] }]);
});

test('a driver rejecting /rotation degrades to the two-way endpoint', async () => {
  const { client, calls } = makeClient({ reject: ['setRotation'] });

  await setWebDriverOrientation(client, 'android', 'portrait-upside-down');

  // Four-way intent collapses to PORTRAIT here — that loss is the documented cost of the fallback.
  assert.deepEqual(
    calls.map((call) => call.method),
    ['setRotation', 'setOrientation'],
  );
  assert.deepEqual(calls[1]?.args, ['PORTRAIT']);
});

// A transport that fails for any reason other than "not implemented" must surface as itself. The
// earlier implementation caught everything, so a timeout or an expired session was reported as an
// orientation-support problem with the real cause discarded.
const NON_FALLBACK_FAILURES: readonly { name: string; error: () => Promise<unknown> }[] = [
  {
    name: 'a request timeout',
    error: () =>
      driverAnswerError(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
          }),
      ),
  },
  {
    name: 'an auth rejection',
    error: answer(403, { value: { error: 'unable to set cookie', message: 'Forbidden' } }),
  },
  {
    name: 'a provider 5xx',
    error: answer(502, { value: { error: 'unknown error', message: 'Bad gateway' } }),
  },
  {
    name: 'a dead session',
    error: async () =>
      new AppError('SESSION_NOT_FOUND', 'WebDriver session has not been created yet.'),
  },
  {
    // The status alone says "not found", but the W3C code says the session died. Reading the code
    // first is what keeps this from being misread as a missing route.
    name: 'a 404 carrying invalid session id',
    error: answer(404, {
      value: {
        error: 'invalid session id',
        message: 'A session is either terminated or not started',
      },
    }),
  },
  {
    name: 'a 405 carrying a non-routing error code',
    error: answer(405, { value: { error: 'timeout', message: 'Session timed out' } }),
  },
];

for (const failure of NON_FALLBACK_FAILURES) {
  test(`${failure.name} surfaces instead of falling through to the next transport`, async () => {
    const { client, calls } = makeClient({ reject: ['setRotation'], rejectWith: failure.error });

    await assert.rejects(
      () => setWebDriverOrientation(client, 'android', 'portrait'),
      (error: unknown) => {
        // The original error, not a "rejected both endpoints" wrapper.
        assert.doesNotMatch(String((error as Error).message), /Could not set device orientation/);
        return true;
      },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ['setRotation'],
    );
  });
}

test('exhausting both endpoints reports the rotation and each attempt', async () => {
  const { client } = makeClient({ reject: ['setRotation', 'setOrientation'] });

  await assert.rejects(
    () => setWebDriverOrientation(client, 'android', 'landscape-left'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /landscape-left/);
      assert.match(String(error.details?.hint), /--provider-device-orientation/);
      const attempts = error.details?.attempts;
      assert.ok(Array.isArray(attempts));
      assert.deepEqual(
        attempts.map((attempt) => (attempt as { transport: string }).transport),
        ['rotation', 'orientation'],
      );
      return true;
    },
  );
});
