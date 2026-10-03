import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatSnapshotLine } from '../snapshot-lines.ts';
import { formatRole } from '@agent-device/kernel/snapshot';

test('formatSnapshotLine marks focused nodes', () => {
  const line = formatSnapshotLine(
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Button',
      kind: formatRole('Button'),
      label: 'General',
      enabled: true,
      focused: true,
    },
    0,
    false,
    undefined,
    { summarizeTextSurfaces: true },
  );

  assert.match(line, /\[focused\]/);
});
