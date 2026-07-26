import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  extractCommandEvents,
  isActualLocalCliHelpProbe,
  isAllowedLocalCliHelpCommand,
} from './local-cli-help-policy.ts';

test('allowed wrapper segments do not satisfy the local-help requirement by themselves', () => {
  for (const command of ['cat', `printf 'help'`]) {
    assert.equal(isAllowedLocalCliHelpCommand(command), true);
    assert.equal(isActualLocalCliHelpProbe(command), false);
  }
});

test('a real local agent-device help segment satisfies the requirement through allowed wrappers', () => {
  for (const command of [
    'node bin/agent-device.mjs --help',
    'agent-device help workflow',
    'node bin/agent-device.mjs help workflow | cat',
    `/bin/zsh -lc 'node bin/agent-device.mjs snapshot --help 2>&1 | cat'`,
  ]) {
    assert.equal(isAllowedLocalCliHelpCommand(command), true);
    assert.equal(isActualLocalCliHelpProbe(command), true);
  }
});

test('a help probe combined with a forbidden runtime segment is neither allowed nor sufficient', () => {
  const command = 'node bin/agent-device.mjs --help && agent-device open Settings';
  assert.equal(isAllowedLocalCliHelpCommand(command), false);
  assert.equal(isActualLocalCliHelpProbe(command), false);
});

test('command events are extracted from direct and tool-call event shapes', () => {
  assert.deepEqual(
    extractCommandEvents({
      events: [
        { type: 'command', command: 'cat' },
        { type: 'toolCall', args: { command: 'node bin/agent-device.mjs --help' } },
        { type: 'toolCall', args: { cmd: 'agent-device help workflow' } },
        { type: 'message', command: 'ignored' },
      ],
    }),
    ['cat', 'node bin/agent-device.mjs --help', 'agent-device help workflow'],
  );
});
