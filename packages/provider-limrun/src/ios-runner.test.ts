import { expect, test, vi } from 'vitest';
import type { LimrunIosHost } from './ios-host.ts';
import { createLimrunIosRunner } from './ios-runner.ts';

test('the forwarded runner endpoint scrubs text and structured diagnostics', async () => {
  const token = 'synthetic  instance-token';
  type RunnerHost = LimrunIosHost['apple']['runner'];
  const createLaunchedProvider = vi.fn<RunnerHost['createLaunchedProvider']>(
    async () => ({}) as Awaited<ReturnType<RunnerHost['createLaunchedProvider']>>,
  );
  const host = {
    apple: {
      applicationTools: {},
      runner: {
        mintToken: () => 'runner-token',
        createLaunchedProvider,
        createRuntime: async () => ({}),
      },
    },
    kit: {},
  } as unknown as LimrunIosHost;
  await createLimrunIosRunner(
    { apiUrl: 'https://instance.invalid/api', token } as Parameters<
      typeof createLimrunIosRunner
    >[0],
    host,
  );
  const diagnostics = createLaunchedProvider.mock.calls[0]?.[1].endpoint.http?.diagnostics;
  expect(diagnostics?.scrubText('refused ' + token)).toBe('refused [REDACTED]');
  expect(
    diagnostics?.scrubPayload({
      ok: false,
      error: { code: 'APP_NOT_RUNNING', message: 'refused ' + token, [token]: 'echo' },
    }),
  ).toEqual({
    ok: false,
    error: { code: 'APP_NOT_RUNNING', message: 'refused [REDACTED]' },
  });
});
