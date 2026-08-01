import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import type { WebDriverClient } from './webdriver-client.ts';
import { setWebDriverOrientation } from './webdriver-orientation.ts';

type Call = { method: string; args: unknown[] };

/** A driver answering "I do not implement this route" — the only case that earns a fallback. */
function unsupportedEndpointError(): AppError {
  return new AppError('COMMAND_FAILED', 'Unknown command', {
    status: 404,
    response: { value: { error: 'unknown command' } },
  });
}

function makeClient(options: { reject?: readonly string[]; rejectWith?: () => unknown } = {}): {
  client: WebDriverClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const reject = new Set(options.reject ?? []);
  const rejectWith = options.rejectWith ?? unsupportedEndpointError;
  const record = (method: string) => {
    return async (...args: unknown[]): Promise<void> => {
      calls.push({ method, args });
      if (reject.has(method)) throw rejectWith();
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
const NON_FALLBACK_FAILURES: readonly { name: string; error: () => unknown }[] = [
  {
    name: 'a request timeout',
    error: () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }),
  },
  {
    name: 'an auth rejection',
    error: () => new AppError('COMMAND_FAILED', 'Forbidden', { status: 403 }),
  },
  {
    name: 'a provider 5xx',
    error: () => new AppError('COMMAND_FAILED', 'Bad gateway', { status: 502 }),
  },
  {
    name: 'a dead session',
    error: () => new AppError('SESSION_NOT_FOUND', 'WebDriver session has not been created yet.'),
  },
  {
    // The status alone says "not found", but the W3C code says the session died. Reading the code
    // first is what keeps this from being misread as a missing route.
    name: 'a 404 carrying invalid session id',
    error: () =>
      new AppError('COMMAND_FAILED', 'A session is either terminated or not started', {
        status: 404,
        response: { value: { error: 'invalid session id' } },
      }),
  },
  {
    name: 'a 405 carrying a non-routing error code',
    error: () =>
      new AppError('COMMAND_FAILED', 'Session timed out', {
        status: 405,
        response: { value: { error: 'timeout' } },
      }),
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
