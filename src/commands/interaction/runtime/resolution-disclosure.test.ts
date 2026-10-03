import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildRefResolution } from './resolution-disclosure.ts';
import { selectorSnapshot } from './__tests__/test-utils/index.ts';

test('buildRefResolution is the shared exact and label-fallback disclosure constructor', () => {
  const node = selectorSnapshot().nodes[0]!;

  assert.deepEqual(buildRefResolution('e1', node, 'exact').resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'exact',
  });
  assert.deepEqual(buildRefResolution('e1', node, 'label-fallback').resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'label-fallback',
  });
});
