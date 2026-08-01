// Failures the contention retry policy must classify, run by the gate test in a
// child Vitest process (test/contention-retry-fixtures/vitest.fixture.config.ts)
// and never by the normal suites. Each name is asserted there.

import { expect, test } from 'vitest';
import {
  RUNNER_TIMEOUT_META,
  RUNNER_TIMEOUT_TOKEN_ENV,
} from '../../scripts/lib/runner-timeout-meta.ts';

const RUNNER_TIMEOUT_MESSAGE =
  'Test timed out in 50ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".';

/** What a test body can do to `task.meta`, which the policy must not trust. */
function forgeMark(task: { meta: object }, value: unknown): void {
  (task.meta as Record<string, unknown>)[RUNNER_TIMEOUT_META] = value;
}

function blockPastBudget(): void {
  const until = Date.now() + 200;
  while (Date.now() < until) {
    // Deny the runner's timeout timer a turn until the budget is long gone.
  }
}

test('genuine runner timeout', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}, 50);

test('timeout message thrown immediately', () => {
  throw new Error(RUNNER_TIMEOUT_MESSAGE);
}, 50);

test('timeout message thrown after blocking the event loop past the budget', () => {
  blockPastBudget();
  throw new Error(`FORGED ${RUNNER_TIMEOUT_MESSAGE}`);
}, 50);

test('assertion failure after blocking the event loop past the budget', () => {
  blockPastBudget();
  expect('DEVICE_IN_USE').toBe('OK');
}, 50);

test('plain assertion failure', () => {
  expect('DEVICE_IN_USE').toBe('OK');
});

test('test writes the provenance marker itself', ({ task }) => {
  forgeMark(task, true);
  throw new Error('DEVICE_IN_USE');
});

test('test writes the marker after blocking the event loop past the budget', ({ task }) => {
  forgeMark(task, true);
  blockPastBudget();
  throw new Error(RUNNER_TIMEOUT_MESSAGE);
}, 50);

test('test writes the marker from the environment it can still read', ({ task }) => {
  forgeMark(task, process.env[RUNNER_TIMEOUT_TOKEN_ENV] ?? 'guess');
  throw new Error(RUNNER_TIMEOUT_MESSAGE);
});
