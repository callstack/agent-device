import assert from 'node:assert/strict';
import { test } from 'vitest';

import { keyEvents, MEDIA_KEYS, NAVIGATION_KEYS } from './keys.ts';

test('select sends Enter with text so a focused button receives a click', () => {
  const [down, up] = keyEvents(NAVIGATION_KEYS.select);

  assert.equal(down!.type, 'keyDown');
  assert.equal(down!.text, '\r');
  assert.equal(up!.type, 'keyUp');
});

test('rewind and fast-forward send the TV media key codes 412 and 417 without text', () => {
  const media = (key: string, keyCode: number) => ({
    key,
    code: key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });

  const rewind = keyEvents(MEDIA_KEYS['media-rewind']);
  const fastForward = keyEvents(MEDIA_KEYS['media-fast-forward']);

  assert.deepEqual(rewind, [
    { ...media('MediaRewind', 412), type: 'keyDown' },
    { ...media('MediaRewind', 412), type: 'keyUp' },
  ]);
  assert.deepEqual(fastForward, [
    { ...media('MediaFastForward', 417), type: 'keyDown' },
    { ...media('MediaFastForward', 417), type: 'keyUp' },
  ]);
});
