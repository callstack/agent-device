import assert from 'node:assert/strict';
import { test } from 'vitest';
import { extractReadableText } from '../text-surface.ts';

test('extractReadableText ignores generic implementation identifiers as fallback text', () => {
  assert.equal(
    extractReadableText({
      type: 'android.widget.TextView',
      identifier: 'com.example:id/content_frame',
    }),
    '',
  );
  assert.equal(
    extractReadableText({
      type: 'AXStaticText',
      identifier: '_NS:248',
    }),
    '',
  );
});
