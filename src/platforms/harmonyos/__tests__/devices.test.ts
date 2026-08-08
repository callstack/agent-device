import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseHarmonyTargetList } from '../devices.ts';

test('parseHarmonyTargetList keeps HDC target ids and ignores its empty sentinel', () => {
  assert.deepEqual(parseHarmonyTargetList('\n127.0.0.1:5555\n9CN0224725020054\n[Empty]\n'), [
    '127.0.0.1:5555',
    '9CN0224725020054',
  ]);
});
