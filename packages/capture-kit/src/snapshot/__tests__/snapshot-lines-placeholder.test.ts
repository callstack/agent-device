import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatSnapshotLine } from '../snapshot-lines.ts';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

function textField(facts: Partial<SnapshotNode>): SnapshotNode {
  return {
    ref: 'e4',
    index: 0,
    depth: 0,
    type: 'android.widget.EditText',
    kind: formatRole('android.widget.EditText'),
    editable: true,
    ...facts,
  };
}

function interactiveLine(node: SnapshotNode): string {
  return formatSnapshotLine(node, 0, false, undefined, { summarizeTextSurfaces: true });
}

test('an empty text field with only a placeholder prints it as placeholder metadata', () => {
  assert.equal(
    interactiveLine(textField({ placeholder: 'Search', hintShowing: false })),
    '@e4 [text-field] [editable] [placeholder:"Search"]',
  );
});

test('a text field with a value keeps the value and omits the placeholder', () => {
  assert.equal(
    interactiveLine(textField({ value: 'coffee', placeholder: 'Search' })),
    '@e4 [text-field] "coffee" [editable]',
  );
});

test('a text field with a label omits the placeholder', () => {
  assert.equal(
    interactiveLine(textField({ label: 'Search', placeholder: 'Search', hintShowing: true })),
    '@e4 [text-field] "Search" [editable]',
  );
});
