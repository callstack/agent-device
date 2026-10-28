import { afterEach, expect, test, vi } from 'vitest';
import {
  clearRequestAbortRegistration,
  registerRequestAbort,
  withRequestDeadline,
} from '@agent-device/host-kit/request';
import type { ApplicationLifecycleExecution } from '@agent-device/contracts/application-lifecycle-runtime';
import type { CommandFlags } from '@agent-device/contracts/command';
import { applicationLifecycleExecutionFromRequest } from './application-lifecycle-execution.ts';

const ADMITTED_AT_MS = 1_000_000;

afterEach(() => {
  vi.useRealTimers();
});

function openExecution(
  requestId: string | undefined,
  flags: CommandFlags = {},
): ApplicationLifecycleExecution {
  return applicationLifecycleExecutionFromRequest(
    {
      token: 'token',
      session: 'default',
      command: 'open',
      positionals: ['com.example.app'],
      flags,
      meta: { requestId },
    },
    '/tmp/request.log',
  );
}

/** Admits `requestId` at `ADMITTED_AT_MS`, then reads its execution 5 s later. */
function executionAfterAdmission(requestId: string, flags?: CommandFlags) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ADMITTED_AT_MS);
  const registration = registerRequestAbort(requestId);
  try {
    vi.setSystemTime(ADMITTED_AT_MS + 5_000);
    return openExecution(requestId, flags);
  } finally {
    clearRequestAbortRegistration(registration);
  }
}

test('an open must settle within its client envelope less the daemon result margin', () => {
  expect(executionAfterAdmission('open-default-envelope').requestDeadlineAtMs).toBe(
    ADMITTED_AT_MS + 60_000,
  );
});

test('open --timeout moves the deadline with the envelope it widens', () => {
  expect(
    executionAfterAdmission('open-widened-envelope', { timeoutMs: 120_000 }).requestDeadlineAtMs,
  ).toBe(ADMITTED_AT_MS + 120_000);
});

test('an enforced request deadline is the deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ADMITTED_AT_MS);
  let execution: ApplicationLifecycleExecution | undefined;
  await withRequestDeadline('open-in-bounded-batch', 20_000, async () => {
    execution = openExecution('open-in-bounded-batch');
    return { ok: true, data: {} };
  });
  expect(execution?.requestDeadlineAtMs).toBe(ADMITTED_AT_MS + 20_000);
});

test('a request no transport admitted has no deadline', () => {
  expect(openExecution(undefined).requestDeadlineAtMs).toBeUndefined();
  expect(openExecution('never-admitted').requestDeadlineAtMs).toBeUndefined();
});
