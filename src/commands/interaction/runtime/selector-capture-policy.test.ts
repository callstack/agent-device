import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseSelectorChain } from '../../../utils/selectors-parse.ts';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';

test('selector capture policy reads full snapshots for focused predicates', () => {
  assert.deepEqual(deriveSelectorCapturePolicy({ predicate: 'focused' }), {
    includeRects: false,
    interactiveOnly: false,
  });
});

test('selector capture policy reads full snapshots for focus selectors', () => {
  assert.deepEqual(
    deriveSelectorCapturePolicy({ selectorChain: parseSelectorChain('focused=true') }),
    {
      includeRects: false,
      interactiveOnly: false,
    },
  );
});

test('selector capture policy keeps rect reads separate from focus reads', () => {
  assert.deepEqual(deriveSelectorCapturePolicy({ predicate: 'visible' }), {
    includeRects: true,
    interactiveOnly: false,
  });
});

test('selector capture policy leaves ordinary selectors non-interactive', () => {
  assert.deepEqual(
    deriveSelectorCapturePolicy({ selectorChain: parseSelectorChain('label="Continue"') }),
    {
      includeRects: false,
      interactiveOnly: false,
    },
  );
});
