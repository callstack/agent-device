import assert from 'node:assert/strict';
import { test } from 'vitest';
import { HARDWARE_KEYS, parseHardwareKey, toAndroidHardwareKeycode } from './tv-remote.ts';

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

test('a raw Android keycode parses to its token and sends that keycode', () => {
  assert.equal(parseHardwareKey('android-keycode:300'), 'android-keycode:300');
  assert.equal(parseHardwareKey('ANDROID-KEYCODE:1'), 'android-keycode:1');
  assert.equal(toAndroidHardwareKeycode('android-keycode:300'), 300);
  assert.equal(
    toAndroidHardwareKeycode(parseHardwareKey('android-keycode:2147483647')),
    2147483647,
  );
});

test.each([
  undefined,
  '',
  'volume',
  'home',
  'toString',
  'KEYCODE_VOLUME_UP',
  '24',
  'android-keycode:',
  'android-keycode:0',
  'android-keycode:007',
  'android-keycode:-1',
  'android-keycode:1.5',
  'android-keycode:2147483648',
  'android-keycode:24 ',
  'keycode:24',
])('an unknown hardware key %j is INVALID_ARGS naming every key', (value) => {
  assert.throws(() => parseHardwareKey(value), {
    code: 'INVALID_ARGS',
    message: `hardware-key key must be one of: ${HARDWARE_KEYS.join(', ')}, or android-keycode:<n> with n from 1 to 2147483647.`,
  });
});
