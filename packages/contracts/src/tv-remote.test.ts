import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  HARDWARE_KEYS,
  parseHardwareKey,
  parseTvRemoteButton,
  TV_REMOTE_BUTTONS,
  toAndroidHardwareKeycode,
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

test('every hardware key maps to its Android KeyEvent keycode', () => {
  assert.deepEqual(
    Object.fromEntries(HARDWARE_KEYS.map((key) => [key, toAndroidHardwareKeycode(key)])),
    {
      'volume-up': 24,
      'volume-down': 25,
      mute: 164,
      power: 26,
      sleep: 223,
      wake: 224,
      'media-play-pause': 85,
      'media-next': 87,
      'media-previous': 88,
      'media-rewind': 89,
      'media-fast-forward': 90,
      'channel-up': 166,
      'channel-down': 167,
      'last-channel': 229,
      guide: 172,
      info: 165,
      captions: 175,
      'tv-input': 178,
      'color-red': 183,
      'color-green': 184,
      'color-yellow': 185,
      'color-blue': 186,
    },
  );
});

test('hardware key names parse case-insensitively', () => {
  assert.equal(parseHardwareKey('Volume-Up'), 'volume-up');
  assert.equal(parseHardwareKey('MEDIA-PLAY-PAUSE'), 'media-play-pause');
});

test.each([undefined, '', 'volume', 'home', 'toString', 'KEYCODE_VOLUME_UP', '24'])(
  'an unknown hardware key %j is INVALID_ARGS naming every key',
  (value) => {
    assert.throws(() => parseHardwareKey(value), {
      code: 'INVALID_ARGS',
      message: `hardware-key key must be one of: ${HARDWARE_KEYS.join(', ')}.`,
    });
  },
);
