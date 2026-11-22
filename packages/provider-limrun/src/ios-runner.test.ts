import { expect, test, vi } from 'vitest';
import type { LimrunIosHost } from './ios-host.ts';
import { createLimrunIosRunner } from './ios-runner.ts';

test('the forwarded runner endpoint scrubs replies before the host consumes them', async () => {
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
  const http = createLaunchedProvider.mock.calls[0]?.[1].endpoint.http;
  const rejected = Response.json(
    { ok: false, error: { code: 'APP_NOT_RUNNING', message: 'refused ' + token, [token]: 'echo' } },
    { status: 409, headers: { 'x-agent-device-runner-auth': 'required' } },
  );
  const failure = http?.transformResponse?.(rejected) ?? rejected;
  expect(failure.status).toBe(409);
  expect(failure.headers.get('x-agent-device-runner-auth')).toBe('required');
  expect(await failure.json()).toEqual({
    ok: false,
    error: { code: 'APP_NOT_RUNNING', message: 'refused [REDACTED]' },
  });

  const accepted = Response.json({
    ok: true,
    data: { gestureFallback: 'coordinate', gestureFallbackMessage: 'used ' + token },
  });
  const success = http?.transformResponse?.(accepted) ?? accepted;
  expect(await success.json()).toEqual({
    ok: true,
    data: { gestureFallback: 'coordinate', gestureFallbackMessage: 'used [REDACTED]' },
  });
});
