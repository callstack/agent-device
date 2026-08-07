import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readSnapshotQualityVerdict, renderSnapshotQualityWarnings } from '../snapshot-quality.ts';

const pinned = {
  state: 'recovered',
  backend: 'private-ax',
  reasonCode: 'requested-backend',
} as const;

test('a capped custom-action pass discloses what it did not read', () => {
  const warnings = renderSnapshotQualityWarnings(
    { ...pinned, customActions: { read: 12, candidates: 19 } },
    [],
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /read for 12 of 19 merged elements/);
  assert.match(warnings[0] ?? '', /remaining 7 were not read/);
  // The point of the line: absence must not read as proof of absence.
  assert.match(warnings[0] ?? '', /not evidence that they have none/);
  assert.match(warnings[0] ?? '', /on-screen ones first/);
  assert.match(warnings[0] ?? '', /Scroll them into view/);
});

test('a complete custom-action pass says nothing', () => {
  assert.deepEqual(
    renderSnapshotQualityWarnings({ ...pinned, customActions: { read: 19, candidates: 19 } }, []),
    [],
  );
  // No merged elements at all is also complete.
  assert.deepEqual(
    renderSnapshotQualityWarnings({ ...pinned, customActions: { read: 0, candidates: 0 } }, []),
    [],
  );
});

test('a capture that never asked for actions has no coverage and no line', () => {
  assert.deepEqual(renderSnapshotQualityWarnings(pinned, []), []);
});

test('the coverage pair survives verdict parsing, and half a pair does not', () => {
  assert.deepEqual(
    readSnapshotQualityVerdict({
      state: 'recovered',
      backend: 'private-ax',
      customActions: { read: 12, candidates: 19 },
    })?.customActions,
    { read: 12, candidates: 19 },
  );

  // A ratio needs both sides; a partial object is dropped rather than half-read.
  for (const customActions of [{ read: 12 }, { candidates: 19 }, { read: '12', candidates: 19 }]) {
    assert.equal(
      readSnapshotQualityVerdict({ state: 'recovered', backend: 'private-ax', customActions })
        ?.customActions,
      undefined,
    );
  }
});

test('the coverage line is independent of degradation state', () => {
  // A healthy capture can still have hit the read cap.
  const warnings = renderSnapshotQualityWarnings(
    { state: 'healthy', backend: 'private-ax', customActions: { read: 3, candidates: 8 } },
    [],
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /read for 3 of 8 merged elements/);
});
