import { afterEach, expect, test, vi } from 'vitest';
import { withRequestDeadline } from '@agent-device/host-kit/request';
import type { ApplicationLifecycleExecution } from '@agent-device/contracts/application-lifecycle-runtime';
import { applicationLifecycleExecutionFromRequest } from './application-lifecycle-execution.ts';

const NOW_MS = 1_000_000;

afterEach(() => {
  vi.useRealTimers();
});

function openExecution(requestId: string | undefined): ApplicationLifecycleExecution {
  return applicationLifecycleExecutionFromRequest(
    {
      token: 'token',
      session: 'default',
      command: 'open',
      positionals: ['com.example.app'],
      meta: { requestId },
    },
    '/tmp/request.log',
  );
}

test('an enforced request deadline is the deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  let execution: ApplicationLifecycleExecution | undefined;
  await withRequestDeadline('open-in-bounded-batch', 20_000, async () => {
    execution = openExecution('open-in-bounded-batch');
    return { ok: true, data: {} };
  });
  expect(execution?.requestDeadlineAtMs).toBe(NOW_MS + 20_000);
});

test('a request no transport admitted has no deadline', () => {
  expect(openExecution(undefined).requestDeadlineAtMs).toBeUndefined();
  expect(openExecution('never-admitted').requestDeadlineAtMs).toBeUndefined();
});
