import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '../__tests__/test-utils/snapshot-builders.ts';
import {
  absenceCaptureOptionMessage,
  absenceCaptureOptionRefusal,
  classifyAbsenceObservation,
} from './absence-observation.ts';

test('classifies a complete capture with no selector matches as absent', () => {
  const observation = classifyAbsenceObservation(makeSnapshotState([]), []);

  assert.deepEqual(observation, { kind: 'absent', matches: 0 });
});

test('classifies matches as present and exposes only stable first-match fields', () => {
  const first = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'save',
      label: 'Save',
      value: 'Save value',
      rect: { x: 10, y: 20, width: 80, height: 30 },
      visibleToUser: false,
    },
  ]).nodes[0]!;
  const second = makeSnapshotState([{ index: 0, type: 'XCUIElementTypeButton', label: 'Other' }])
    .nodes[0]!;

  const observation = classifyAbsenceObservation(makeSnapshotState([]), [first, second]);

  assert.deepEqual(observation, {
    kind: 'present',
    matches: 2,
    firstMatch: { id: 'save', role: 'button', label: 'Save' },
  });
  assert.equal('rect' in observation.firstMatch, false);
  assert.equal('visibleToUser' in observation.firstMatch, false);
});

test('bounds optional first-match text by UTF-8 bytes', () => {
  const snapshot = makeSnapshotState([
    { index: 0, type: 'Button', value: '\u{1F642}'.repeat(100) },
  ]);

  const observation = classifyAbsenceObservation(snapshot, [snapshot.nodes[0]!]);

  assert.equal(observation.kind, 'present');
  if (observation.kind === 'present') {
    assert.equal(Buffer.byteLength(observation.firstMatch.text ?? '', 'utf8') <= 256, true);
    assert.equal(observation.firstMatch.text, '\u{1F642}'.repeat(64));
  }
});

test('classifies sparse and truncated captures before evaluating zero matches', () => {
  const sparse = classifyAbsenceObservation(
    makeSnapshotState([], {
      snapshotQuality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
    }),
    [],
  );
  const truncated = classifyAbsenceObservation(makeSnapshotState([], { truncated: true }), []);

  assert.deepEqual(sparse, {
    kind: 'sparse',
    matches: 0,
    quality: {
      state: 'sparse',
      backend: 'private-ax',
      reason: 'sparse tree',
      reasonCode: 'sparse-tree',
    },
  });
  assert.deepEqual(truncated, { kind: 'truncated', matches: 0 });
});

test('classifies a quality-less legacy iOS root-only capture as sparse', () => {
  const snapshot = makeSnapshotState([{ index: 0, type: 'XCUIElementTypeApplication' }], {
    backend: 'xctest',
    producer: 'apple-runner',
  });

  assert.deepEqual(classifyAbsenceObservation(snapshot, []), {
    kind: 'sparse',
    matches: 0,
    quality: {
      state: 'sparse',
      backend: 'tree',
      reason: 'legacy iOS capture exposed only the application root',
      reasonCode: 'sparse-tree',
    },
  });
});

test('refuses scoped and depth-limited absence captures', () => {
  assert.equal(absenceCaptureOptionRefusal({ scope: 'Login' }), 'scope');
  assert.equal(absenceCaptureOptionRefusal({ depth: 2 }), 'depth');
  assert.equal(absenceCaptureOptionRefusal({ scope: 'Login', depth: 2 }), 'scope');
  assert.equal(absenceCaptureOptionRefusal({}), undefined);
  assert.match(absenceCaptureOptionMessage('scope'), /unscoped capture/);
  assert.match(absenceCaptureOptionMessage('depth'), /full-depth capture/);
});
