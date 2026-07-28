// Failures the contention retry policy must classify, run by the gate test in a
// child Vitest process (test/contention-retry-fixtures/vitest.fixture.config.ts)
// and never by the normal suites. Each name is asserted there.

import { expect, test } from 'vitest';

const RUNNER_TIMEOUT_MESSAGE =
  'Test timed out in 50ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".';

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
