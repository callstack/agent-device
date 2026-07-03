import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode } from '../../kernel/snapshot.ts';
import type { CaptureSnapshotResult } from '../../client/client-types.ts';
import { snapshotCliOutput } from './output.ts';

function buildResult(raw: RawSnapshotNode[]): CaptureSnapshotResult {
  return {
    nodes: attachRefs(raw),
    truncated: false,
    identifiers: { session: 'qa' },
  };
}

const REPEATED_CHAIN: RawSnapshotNode[] = [
  { index: 0, type: 'ScrollView', label: 'Anthropic - Headquarters, 548 Market St', depth: 0 },
  {
    index: 1,
    type: 'Other',
    label: 'Anthropic - Headquarters, 548 Market St',
    depth: 1,
    parentIndex: 0,
  },
  {
    index: 2,
    type: 'Button',
    label: 'Anthropic - Headquarters, 548 Market St',
    depth: 2,
    parentIndex: 1,
  },
  {
    index: 3,
    type: 'Button',
    label: 'Anthropic - Headquarters, 548 Market St',
    depth: 3,
    parentIndex: 2,
  },
];

test('default (non-raw) output dedups repeated ancestor labels in both text and json', () => {
  const output = snapshotCliOutput({ result: buildResult(REPEATED_CHAIN) });

  const jsonNodes = (output.jsonData as { nodes: Array<Record<string, unknown>> }).nodes;
  assert.equal(jsonNodes[0]!.label, 'Anthropic - Headquarters, 548 Market St');
  assert.equal(jsonNodes[1]!.label, undefined);
  assert.equal(jsonNodes[1]!.inheritsLabel, true);
  assert.equal(jsonNodes[2]!.inheritsLabel, true);
  assert.equal(jsonNodes[3]!.inheritsLabel, true);

  const occurrences = output.text!.split('Anthropic - Headquarters, 548 Market St').length - 1;
  assert.equal(occurrences, 1);
  assert.match(output.text!, /same label as parent/);
});

test('--raw preserves the original repeated labels byte-for-byte', () => {
  const output = snapshotCliOutput({ result: buildResult(REPEATED_CHAIN), raw: true });

  const jsonNodes = (output.jsonData as { nodes: Array<Record<string, unknown>> }).nodes;
  for (const node of jsonNodes) {
    assert.equal(node.label, 'Anthropic - Headquarters, 548 Market St');
    assert.equal(node.inheritsLabel, undefined);
  }
  const occurrences = output.text!.split('Anthropic - Headquarters, 548 Market St').length - 1;
  assert.equal(occurrences, 4);
});

test('distinct labels across the chain are all preserved', () => {
  const output = snapshotCliOutput({
    result: buildResult([
      { index: 0, type: 'ScrollView', label: 'Map', depth: 0 },
      { index: 1, type: 'Button', label: 'Anthropic HQ', depth: 1, parentIndex: 0 },
    ]),
  });

  const jsonNodes = (output.jsonData as { nodes: Array<Record<string, unknown>> }).nodes;
  assert.equal(jsonNodes[0]!.label, 'Map');
  assert.equal(jsonNodes[1]!.label, 'Anthropic HQ');
});
