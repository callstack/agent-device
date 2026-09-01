import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseAppearanceAction,
  parseSettingState,
  summarizeCommandAttemptFailures,
} from '../settings-parsing.ts';
import { assertThrowsAppError } from './test-utils/app-error.ts';

test('parseAppearanceAction accepts the three actions in any casing or padding', () => {
  assert.equal(parseAppearanceAction('light'), 'light');
  assert.equal(parseAppearanceAction('DARK'), 'dark');
  assert.equal(parseAppearanceAction('  Toggle  '), 'toggle');
});

test('parseAppearanceAction rejects anything else and names the accepted set', () => {
  assertThrowsAppError(() => parseAppearanceAction('bright'), { code: 'INVALID_ARGS' });
  assertThrowsAppError(() => parseAppearanceAction(''), { code: 'INVALID_ARGS' });
});

test('parseSettingState reads every on and off spelling', () => {
  for (const on of ['on', 'ON', 'true', '1']) assert.equal(parseSettingState(on), true);
  for (const off of ['off', 'OFF', 'false', '0']) assert.equal(parseSettingState(off), false);
});

test('parseSettingState rejects a state that is neither', () => {
  assertThrowsAppError(() => parseSettingState('maybe'), { code: 'INVALID_ARGS' });
  assertThrowsAppError(() => parseSettingState('2'), { code: 'INVALID_ARGS' });
});

test('summarizeCommandAttemptFailures joins args and truncates stderr to its budget', () => {
  const [summary] = summarizeCommandAttemptFailures([
    { args: ['shell', 'cmd', 'fingerprint'], stdout: 'out', stderr: 'x'.repeat(500), exitCode: 2 },
  ]);

  assert.equal(summary?.args, 'shell cmd fingerprint');
  assert.equal(summary?.exitCode, 2);
  assert.equal(summary?.stderr.length, 400);
});

test('summarizeCommandAttemptFailures keeps every attempt in order', () => {
  const summaries = summarizeCommandAttemptFailures([
    { args: ['first'], stdout: '', stderr: 'a', exitCode: 1 },
    { args: ['second'], stdout: '', stderr: 'b', exitCode: 9 },
  ]);

  assert.deepEqual(
    summaries.map(({ args, exitCode }) => `${args}:${exitCode}`),
    ['first:1', 'second:9'],
  );
});
