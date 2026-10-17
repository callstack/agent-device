import assert from 'node:assert/strict';
import { test } from 'vitest';
import { extractNodeText, isFillableType, normalizeType } from './snapshot-text.ts';

test('snapshot text semantics normalize roles, identify fillable controls, and extract the first text field', () => {
  assert.equal(normalizeType('XCUIElementTypeButton'), 'button');
  assert.equal(normalizeType('android.widget.EditText'), 'edittext');
  assert.equal(isFillableType('XCUIElementTypeTextField', 'ios'), true);
  assert.equal(isFillableType('android.widget.EditText', 'android'), true);
  assert.equal(
    extractNodeText({
      label: '  ',
      value: '  Enter name  ',
      identifier: 'name',
    }),
    'Enter name',
  );
});
