import assert from 'node:assert/strict';
import { test } from 'vitest';

import { keyEvents, MEDIA_KEYS, NAVIGATION_KEYS } from './keys.ts';

test('select sends Enter with text so a focused button receives a click', () => {
  const [down, up] = keyEvents(NAVIGATION_KEYS.select);

  assert.equal(down!.type, 'keyDown');
  assert.equal(down!.text, '\r');
  assert.equal(up!.type, 'keyUp');
});

test.each([
  ['media-play', 'MediaPlay', 415],
  ['media-pause', 'MediaPause', 19],
  ['media-stop', 'MediaStop', 413],
  ['media-rewind', 'MediaRewind', 412],
  ['media-fast-forward', 'MediaFastForward', 417],
] as const)('%s sends the TV media key %s with key code %d and no text', (button, key, keyCode) => {
  const media = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };

  const events = keyEvents(MEDIA_KEYS[button]);

  assert.deepEqual(events, [
    { ...media, type: 'keyDown' },
    { ...media, type: 'keyUp' },
  ]);
});
