import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { verifyDoublespeedConnection } from './connection-verification.ts';
import { scriptedFetch } from './runtime.fixtures.ts';

test('verification reads the simulator list without creating a simulator', async () => {
  const { fetch, calls } = scriptedFetch([() => ({ body: { simulators: [] } })]);
  vi.stubGlobal('fetch', fetch);
  try {
    const result = await verifyDoublespeedConnection({
      apiKey: 'dsx_test_key',
      clientVersion: '1.2.3',
      device: 'iPhone 16 Pro',
    });
    assert.deepEqual(result, {
      provider: 'doublespeed',
      service: 'Doublespeed',
      verificationMessage: 'Credentials and iOS simulator access verified.',
      device: { status: 'deferred', name: 'Doublespeed iPhone 16 Pro simulator', platform: 'ios' },
      app: {
        status: 'missing',
        message: 'A new Doublespeed simulator does not have your app yet.',
      },
    });
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'GET https://api.mac.doublespeed.ai/v1/xcode/simulators',
    ]);
    expect(calls[0]?.init.headers).toMatchObject({
      'x-agent-device-client': 'agent-device-cli',
      'x-agent-device-version': '1.2.3',
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

test('verification classifies authentication failures without echoing the key', async () => {
  const { fetch } = scriptedFetch([
    () => ({ status: 401, body: { error: { code: 'UNAUTHORIZED' } } }),
  ]);
  vi.stubGlobal('fetch', fetch);
  try {
    await assert.rejects(
      verifyDoublespeedConnection({ apiKey: 'dsx_bad_key', clientVersion: '1.2.3' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
        assert.doesNotMatch(JSON.stringify(error), /dsx_bad_key/);
        return true;
      },
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
