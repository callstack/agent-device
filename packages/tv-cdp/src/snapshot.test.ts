import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';

import { SNAPSHOT_EXPRESSION, type SnapshotCapture } from './snapshot.ts';

function evaluateOnPage(visualViewport: Record<string, number> | undefined) {
  const page = {
    window: { visualViewport },
    document: { activeElement: null, body: null, title: 'Example' },
    innerWidth: 1280,
    innerHeight: 720,
  };
  return runInNewContext(SNAPSHOT_EXPRESSION, page) as SnapshotCapture;
}

test('the page reports its layout viewport and its visual viewport scale', () => {
  const capture = evaluateOnPage({ scale: 1.5, offsetLeft: 0, offsetTop: 0 });

  assert.deepEqual(
    { viewport: { ...capture.viewport }, pageScale: capture.pageScale },
    { viewport: { width: 1280, height: 720 }, pageScale: 1.5 },
  );
});

test('a panned visual viewport reports no page scale', () => {
  assert.equal(evaluateOnPage({ scale: 2, offsetLeft: 40, offsetTop: 0 }).pageScale, null);
  assert.equal(evaluateOnPage({ scale: 2, offsetLeft: 0, offsetTop: 30 }).pageScale, null);
});

test('a browser without visualViewport reports no page scale', () => {
  assert.equal(evaluateOnPage(undefined).pageScale, null);
});
