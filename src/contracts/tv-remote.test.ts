import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseTvRemoteButton,
  TV_REMOTE_BUTTONS,
  toVegaTvRemoteKey,
  tvRemoteDurationMode,
} from './tv-remote.ts';

test('Vega TV remote mapping covers the shared button contract', () => {
  assert.deepEqual(
    Object.fromEntries(TV_REMOTE_BUTTONS.map((button) => [button, toVegaTvRemoteKey(button)])),
    {
      up: 'KEY_UP',
      down: 'KEY_DOWN',
      left: 'KEY_LEFT',
      right: 'KEY_RIGHT',
      select: 'KEY_ENTER',
      menu: 'KEY_MENU',
      home: 'KEY_HOMEPAGE',
      back: 'KEY_BACK',
    },
  );
});

test('TV remote duration semantics stay explicit per platform family', () => {
  assert.equal(tvRemoteDurationMode('android'), 'longpress');
  assert.equal(tvRemoteDurationMode('apple'), 'exact');
  assert.equal(tvRemoteDurationMode('vega'), 'exact');
});

test('shared select aliases normalize before reaching a platform adapter', () => {
  assert.deepEqual(['select', 'ok', 'center', 'enter'].map(parseTvRemoteButton), [
    'select',
    'select',
    'select',
    'select',
  ]);
});
