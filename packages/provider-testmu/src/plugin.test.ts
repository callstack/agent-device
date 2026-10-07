import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import testMuPlugin from './plugin.ts';
import { verifyTestMuConnection } from './testmu-connection-verification.ts';

vi.mock('./testmu-connection-verification.ts', () => ({ verifyTestMuConnection: vi.fn() }));

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function host(env: Record<string, string | undefined>): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '0.0.0-test',
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

test('whitespace-only credentials are missing, not a provider authentication failure', async () => {
  globalThis.fetch = async () => {
    throw new Error('a missing credential must not reach TestMu AI');
  };
  for (const env of [
    { LT_USERNAME: '  ', LT_ACCESS_KEY: 'key' },
    { LT_USERNAME: 'user', LT_ACCESS_KEY: '\t' },
  ]) {
    await assert.rejects(
      testMuPlugin(host(env)).webDriver.listArtifacts!({
        provider: 'testmu',
        providerSessionId: 'SESSION1',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /requires LT_(USERNAME|ACCESS_KEY) in the environment/.test(error.message),
    );
  }
});

test('verification of a hand-authored profile canonicalizes an upper-case app scheme', async () => {
  vi.mocked(verifyTestMuConnection).mockResolvedValue({
    provider: 'testmu',
    service: 'TestMu AI',
    verificationMessage: 'verified',
    device: { status: 'verified', name: 'iPhone 16', platform: 'ios', osVersion: '18.0' },
    app: { status: 'verified', reference: 'lt://APP1' },
  });
  const env = { LT_USERNAME: 'user', LT_ACCESS_KEY: 'key' };
  await testMuPlugin(host(env)).connection.verify({
    flags: {
      json: false,
      help: false,
      version: false,
      platform: 'ios',
      device: 'iPhone 16',
      providerOsVersion: '18.0',
      providerApp: 'LT://APP1',
    },
  });
  assert.equal(vi.mocked(verifyTestMuConnection).mock.calls[0]?.[0].app, 'lt://APP1');
});
