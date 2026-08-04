// extractReplayTargetToken / readRefLabel — token extraction for each
// eligible command shape, and the point-target / ineligible-command guards.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionAction } from '../../types.ts';
import { extractReplayTargetToken, readRefLabel } from '../session-replay-target-token.ts';

// ---------------------------------------------------------------------------

function action(overrides: Partial<SessionAction>): SessionAction {
  return { ts: 0, command: 'click', positionals: [], flags: {}, ...overrides };
}

test('extractReplayTargetToken: click/press/longpress/fill take positional 0', () => {
  for (const command of ['click', 'press', 'longpress', 'fill']) {
    assert.equal(
      extractReplayTargetToken(action({ command, positionals: ['id="save"', 'text'] })),
      'id="save"',
    );
  }
});

test('extractReplayTargetToken: get takes positional 1 (after the text/attrs subcommand)', () => {
  assert.equal(
    extractReplayTargetToken(action({ command: 'get', positionals: ['text', 'id="save"'] })),
    'id="save"',
  );
});

test('extractReplayTargetToken: a two-numeric-positional point target is not eligible', () => {
  assert.equal(
    extractReplayTargetToken(action({ command: 'click', positionals: ['100', '200'] })),
    undefined,
  );
});

test('extractReplayTargetToken: an ineligible command (find/is/wait/scroll) returns undefined', () => {
  for (const command of ['find', 'is', 'wait', 'scroll', 'swipe']) {
    assert.equal(
      extractReplayTargetToken(action({ command, positionals: ['id="save"'] })),
      undefined,
    );
  }
});

test('readRefLabel: reads a string result.refLabel, ignores non-string/empty', () => {
  assert.equal(readRefLabel(action({ result: { refLabel: 'Save' } })), 'Save');
  assert.equal(readRefLabel(action({ result: { refLabel: '' } })), undefined);
  assert.equal(readRefLabel(action({ result: { refLabel: 42 } })), undefined);
  assert.equal(readRefLabel(action({})), undefined);
});

// ---------------------------------------------------------------------------
