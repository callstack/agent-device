import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseTvRemoteButton,
  TV_REMOTE_BUTTONS,
  tvRemoteButtonsForPlatform,
  toAndroidTvRemoteKeyevent,
  toAppleTvRemoteButton,
  toVegaTvRemoteKey,
  tvRemoteDurationMode,
} from './tv-remote.ts';

test('Vega TV remote mapping covers the shared button contract', () => {
  assert.deepEqual(
    Object.fromEntries(
      tvRemoteButtonsForPlatform('vega').map((button) => [button, toVegaTvRemoteKey(button)]),
    ),
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

test('Android TV hardware buttons map to their KeyEvent codes', () => {
  const expected = {
    'volume-up': '24',
    'volume-down': '25',
    mute: '164',
    power: '26',
    sleep: '223',
    wake: '224',
    'media-play-pause': '85',
    'media-next': '87',
    'media-previous': '88',
    'media-rewind': '89',
    'media-fast-forward': '90',
    'channel-up': '166',
    'channel-down': '167',
    'last-channel': '229',
    guide: '172',
    info: '165',
    captions: '175',
    'tv-input': '178',
    'color-red': '183',
    'color-green': '184',
    'color-yellow': '185',
    'color-blue': '186',
  };
  for (const [button, code] of Object.entries(expected)) {
    assert.equal(toAndroidTvRemoteKeyevent(parseTvRemoteButton(button)), code);
  }
  assert.equal(TV_REMOTE_BUTTONS.length, 30);
});

test('raw Android codes and named TV buttons normalize before dispatch', () => {
  assert.equal(parseTvRemoteButton('VOLUME-UP'), 'volume-up');
  assert.equal(parseTvRemoteButton('ANDROID-KEYCODE:300'), 'android-keycode:300');
  assert.equal(
    toAndroidTvRemoteKeyevent(parseTvRemoteButton('android-keycode:2147483647')),
    '2147483647',
  );
});

test.each([
  undefined,
  'volume-sideways',
  'android-keycode:',
  'android-keycode:0',
  'android-keycode:-1',
  'android-keycode:01',
  'android-keycode:1.5',
  'android-keycode:1e2',
  'android-keycode:2147483648',
  'android-keycode:99999999999',
  'android-keycode:300\n',
])('rejects invalid TV button %j', (button) => {
  assert.throws(() => parseTvRemoteButton(button), { code: 'INVALID_ARGS' });
});

test('Apple and Vega maps refuse Android-only buttons instead of passing an absent key', () => {
  for (const button of ['volume-up', 'android-keycode:300'] as const) {
    assert.throws(() => toAppleTvRemoteButton(button), { code: 'UNSUPPORTED_OPERATION' });
    assert.throws(() => toVegaTvRemoteKey(button), { code: 'UNSUPPORTED_OPERATION' });
  }
  assert.deepEqual(tvRemoteButtonsForPlatform('apple'), [
    'up',
    'down',
    'left',
    'right',
    'select',
    'menu',
    'home',
    'back',
  ]);
});
