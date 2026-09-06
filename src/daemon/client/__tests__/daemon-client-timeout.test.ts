import { expect, test } from 'vitest';
import { resolveDaemonRequestTimeoutMs } from '../daemon-client-timeout.ts';

test.each([
  [undefined, 90_000],
  [600_000, 630_000],
  [5_000, 90_000],
])('open startup budget %s leaves cleanup margin in the client envelope', (timeoutMs, expected) => {
  expect(
    resolveDaemonRequestTimeoutMs({
      command: 'open',
      session: 'cold-start',
      positionals: ['Settings'],
      flags: timeoutMs === undefined ? {} : { timeoutMs },
    }),
  ).toBe(expected);
});

test.each([
  [undefined, 270_000],
  [600_000, 630_000],
  [5_000, 240_000],
])('prepare budget %s leaves cleanup margin in the client envelope', (timeoutMs, expected) => {
  expect(
    resolveDaemonRequestTimeoutMs({
      command: 'prepare',
      session: 'cold-start',
      positionals: ['ios-runner'],
      flags: timeoutMs === undefined ? {} : { timeoutMs },
    }),
  ).toBe(expected);
});
