import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseArkUiBounds, parseHarmonyLayout } from '../snapshot.ts';

test('parseArkUiBounds converts API 24 layout bounds into a rectangle', () => {
  assert.deepEqual(parseArkUiBounds('[84,1127][1172,1295]'), {
    x: 84,
    y: 1127,
    width: 1088,
    height: 168,
  });
  assert.equal(parseArkUiBounds('[84,1127][not-a-coordinate,1295]'), undefined);
});

test('parseHarmonyLayout rejects non-object uitest documents', () => {
  assert.throws(() => parseHarmonyLayout('[]'), /invalid layout JSON/i);
});
