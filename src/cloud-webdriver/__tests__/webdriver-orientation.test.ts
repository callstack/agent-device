import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '../../kernel/errors.ts';
import type { WebDriverClient } from '../webdriver-client.ts';
import { setWebDriverOrientation } from '../webdriver-orientation.ts';

type Call = { method: string; args: unknown[] };

function makeClient(options: { reject?: readonly string[] } = {}): {
  client: WebDriverClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const reject = new Set(options.reject ?? []);
  const record = (method: string) => {
    return async (...args: unknown[]): Promise<void> => {
      calls.push({ method, args });
      if (reject.has(method)) throw new Error(`${method} unsupported`);
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
