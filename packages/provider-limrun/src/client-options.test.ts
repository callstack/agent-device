import Limrun from '@limrun/api';
import { expect, test } from 'vitest';
import { fromLimrunOrgApi, limrunUserAgent, LIMRUN_ORG_CLIENT_LOGGING } from './client-options.ts';

test('the Limrun SDK sends the agent-device prefix ahead of its own User-Agent', async () => {
  const userAgents: Array<string | null> = [];
  const limrun = new Limrun({
    apiKey: 'lim_test_key',
    baseURL: 'https://limrun.example',
    maxRetries: 0,
    userAgent: limrunUserAgent('1.2.3'),
    fetch: async (_url, init) => {
      userAgents.push(new Headers(init?.headers).get('user-agent'));
      return new Response(JSON.stringify({ metadata: { id: 'instance-1' }, status: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await limrun.iosInstances.create({});
  await limrun.androidInstances.delete('instance-1');

  expect(userAgents).toHaveLength(2);
  for (const userAgent of userAgents) {
    expect(userAgent).toMatch(/^agent-device-cli\/1\.2\.3 Limrun\/JS /);
  }
});

// The SDK builds an error's message from the response body and logs the failed request around it. Both
// are Limrun's own text, and this client authenticates with the account key, so neither may leave here.
test.each([401, 403, 404, 429, 500])(
  'an account-API refusal answers with its status alone (HTTP %i)',
  async (status) => {
    const apiKey = 'lim_test_key_0123456789abcdef';
    const limrun = new Limrun({
      apiKey,
      baseURL: 'https://limrun.example',
      maxRetries: 0,
      ...LIMRUN_ORG_CLIENT_LOGGING,
      fetch: async () =>
        new Response(JSON.stringify({ message: `key ${apiKey} rejected for account ${apiKey}` }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    });

    let failure: unknown;
    await fromLimrunOrgApi(limrun.iosInstances.list({ limit: 1 })).catch((error: unknown) => {
      failure = error;
    });

    expect(failure).toBeInstanceOf(Error);
    const error = failure as { code?: string; message?: string; details?: Record<string, unknown> };
    expect(error.details).toEqual({
      status,
      reason:
        status === 401 || status === 403
          ? 'limrun_api_unauthorized'
          : status === 404
            ? 'limrun_api_not_found'
            : status === 429
              ? 'limrun_api_rate_limited'
              : 'limrun_api_failed',
    });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
      apiKey,
    );
  },
);

// `off` is the SDK's own value for logging nothing, and the option outranks LIMRUN_LOG. Without it the
// SDK defaults to `warn` and follows that variable, and each failed request's details are written.
test('the organization client this plugin builds logs nothing, whatever LIMRUN_LOG names', () => {
  const previous = process.env.LIMRUN_LOG;
  process.env.LIMRUN_LOG = 'debug';
  try {
    const withoutTheOption = new Limrun({ apiKey: 'lim_test_key' });
    const builtByThisPlugin = new Limrun({
      apiKey: 'lim_test_key',
      ...LIMRUN_ORG_CLIENT_LOGGING,
    });

    expect(withoutTheOption.logLevel).toBe('debug');
    expect(builtByThisPlugin.logLevel).toBe('off');
  } finally {
    if (previous === undefined) delete process.env.LIMRUN_LOG;
    else process.env.LIMRUN_LOG = previous;
  }
});

test('a malformed organization JSON reply never publishes the decoder error', async () => {
  const key = 'syntheticAccountCredential';
  const limrun = new Limrun({
    apiKey: key,
    baseURL: 'https://limrun.example',
    ...LIMRUN_ORG_CLIENT_LOGGING,
    fetch: async () => new Response(key, { headers: { 'content-type': 'application/json' } }),
  });
  await expect(fromLimrunOrgApi(limrun.iosInstances.list({}))).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun organization request failed.',
    details: { reason: 'limrun_api_failed' },
    cause: undefined,
  });
});

test('an aborted organization request preserves cancellation', async () => {
  const controller = new AbortController();
  const limrun = new Limrun({
    apiKey: 'syntheticAccountCredential',
    baseURL: 'https://limrun.example',
    ...LIMRUN_ORG_CLIENT_LOGGING,
  });
  controller.abort();
  await expect(
    fromLimrunOrgApi(limrun.iosInstances.list({}, { signal: controller.signal })),
  ).rejects.toBeInstanceOf(Limrun.APIUserAbortError);
});
