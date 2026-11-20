import { expect, test } from 'vitest';
import type { NativeAuditFinding } from '@agent-device/contracts/capture';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { matchNativeAuditFindings } from './snapshot-audit.ts';

const rect = { x: 10, y: 20, width: 50, height: 44 };
const issue: NativeAuditFinding = {
  source: 'native',
  kind: 'native',
  severity: 'warning',
  platform: 'ios',
  auditType: 'contrast',
  description: 'Low contrast',
  rect,
};
const button: SnapshotNode = {
  index: 0,
  depth: 0,
  ref: 'e1',
  type: 'Button',
  label: 'Save',
  rect,
};

test('matches native point frames within layout tolerance to one named snapshot ref', () => {
  expect(matchNativeAuditFindings([issue], [{ ...button, rect: { ...rect, x: 10.3 } }])).toEqual([
    { ...issue, ref: '@e1', role: 'button', label: 'Save' },
  ]);
});

test('leaves ambiguous, missing and different frames unbound', () => {
  expect(matchNativeAuditFindings([issue], [button, { ...button, index: 1, ref: 'e2' }])).toEqual([
    issue,
  ]);
  expect(matchNativeAuditFindings([issue], [{ ...button, rect: { ...rect, x: 11 } }])).toEqual([
    issue,
  ]);
  const { rect: omitted, ...withoutFrame } = issue;
  void omitted;
  expect(matchNativeAuditFindings([withoutFrame], [button])).toEqual([withoutFrame]);
});
