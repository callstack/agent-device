import { afterEach, expect, test, vi } from 'vitest';
import { managedCommandHorizon } from '../command-horizon.ts';
import { NOW } from './lease-admission.fixtures.ts';

afterEach(() => vi.restoreAllMocks());

test('command horizons reuse descriptor budgets and reject unbounded requests', () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const req = { command: 'wait', session: 'managed', positionals: ['text', 'Ready', '180000'] };
  const wait = managedCommandHorizon(req, NOW - 1_000);
  expect(wait.deadline.remainingMs()).toBe(209_000);
  expect(wait.teardownTimeoutMs).toBe(16_000);
  expect(
    managedCommandHorizon(
      { command: 'install', session: 'managed', positionals: [] },
      NOW,
    ).deadline.remainingMs(),
  ).toBe(180_000);
  expect(() =>
    managedCommandHorizon({ command: 'test', session: 'managed', positionals: [] }, NOW),
  ).toThrow(expect.objectContaining({ details: { reason: 'managed-command-deadline-unbounded' } }));
});
