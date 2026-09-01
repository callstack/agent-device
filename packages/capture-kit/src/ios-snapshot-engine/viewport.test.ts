import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveIosViewportEvidenceFromRoots } from './viewport.ts';

test('viewport evidence prefers reported application and window roots', () => {
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots([
      { type: 'XCUIElementTypeApplication', rectStatus: 'invalid' },
      {
        type: 'XCUIElementTypeWindow',
        rect: { x: 0, y: 0, width: 390, height: 844 },
        rectStatus: 'reported',
      },
    ]),
    { kind: 'reported', rect: { x: 0, y: 0, width: 390, height: 844 } },
  );
});

test('viewport evidence can fall back to the largest top-level root', () => {
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots(
      [
        { type: 'Other', rect: { x: 0, y: 0, width: 100, height: 100 } },
        { type: 'Other', rect: { x: 0, y: 0, width: 200, height: 300 } },
      ],
      { fallbackToLargestRoot: true },
    ),
    { kind: 'reported', rect: { x: 0, y: 0, width: 200, height: 300 } },
  );
});

test('viewport evidence preserves explicit missing geometry reasons', () => {
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots([{ type: 'Application', rectStatus: 'invalid' }]),
    { kind: 'missing', reason: 'invalid' },
  );
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots([{ type: 'Application', rectStatus: 'not-provided' }]),
    { kind: 'missing', reason: 'not-provided' },
  );
});
