import assert from 'node:assert/strict';
import { test } from 'vitest';

import { keyEvents, NAVIGATION_KEYS } from './keys.ts';

test('select sends Enter with text so a focused button receives a click', () => {
  const [down, up] = keyEvents(NAVIGATION_KEYS.select);

  assert.equal(down!.type, 'keyDown');
  assert.equal(down!.text, '\r');
  assert.equal(up!.type, 'keyUp');
});
