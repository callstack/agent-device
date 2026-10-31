import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatSnapshotText } from './snapshot.ts';

const oneButtonSnapshot = {
  nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Button', label: 'Create' }],
  truncated: false,
} as const;

test('formatSnapshotText compacts unchanged snapshots while preserving warnings', () => {
  const text = formatSnapshotText({
    ...oneButtonSnapshot,
    warnings: ['Snapshot warning stays visible.'],
    unchanged: { ageMs: 8_200, nodeCount: 1 },
  });
  assert.match(text, /Snapshot warning stays visible/);
  assert.match(text, /Snapshot unchanged since previous read 8\.2s ago/);
  assert.equal(text.includes('Refs from the previous snapshot are still valid'), true);
  assert.equal(text.includes('find/get/is'), true);
  assert.equal(text.includes('@e1'), false);
});

test('formatSnapshotText compacts unchanged interactive snapshots', () => {
  const text = formatSnapshotText(
    {
      ...oneButtonSnapshot,
      unchanged: { ageMs: 120_000, nodeCount: 73, interactiveOnly: true },
    },
    { flatten: true },
  );
  assert.match(text, /Interactive snapshot unchanged since previous read 2\.0m ago/);
  assert.match(text, /73 visible nodes are unchanged/);
  assert.match(text, /Previous @e refs are still valid/);
});

test('formatSnapshotText keeps raw output full when unchanged metadata is present', () => {
  const text = formatSnapshotText(
    {
      ...oneButtonSnapshot,
      unchanged: { ageMs: 8_200, nodeCount: 1 },
    },
    { raw: true },
  );
  assert.match(text, /Snapshot: 1 nodes/);
  assert.match(text, /"ref":"e1"/);
  assert.doesNotMatch(text, /Snapshot unchanged/);
});
