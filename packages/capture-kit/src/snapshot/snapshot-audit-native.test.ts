import { expect, test } from 'vitest';
import type { AuditFinding, NativeAuditFinding } from '@agent-device/contracts/capture';
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
  expect(
    matchNativeAuditFindings([issue], [{ ...button, rect: { ...rect, x: 10.3 } }], []),
  ).toEqual([{ ...issue, ref: '@e1', role: 'button', label: 'Save' }]);
});

test('leaves ambiguous, missing and different frames unbound', () => {
  expect(
    matchNativeAuditFindings([issue], [button, { ...button, index: 1, ref: 'e2' }], []),
  ).toEqual([issue]);
  expect(matchNativeAuditFindings([issue], [{ ...button, rect: { ...rect, x: 11 } }], [])).toEqual([
    issue,
  ]);
  const { rect: omitted, ...withoutFrame } = issue;
  void omitted;
  expect(matchNativeAuditFindings([withoutFrame], [button], [])).toEqual([withoutFrame]);
});

test('drops a native hit region that a heuristic small-target finding already reports', () => {
  const hitRegion: NativeAuditFinding = { ...issue, auditType: 'hitRegion' };
  const smallTarget: AuditFinding = {
    kind: 'small-target',
    severity: 'warning',
    ref: '@e1',
    role: 'button',
    rect: { ...rect, x: 10.3 },
    detail: { unit: 'pt', width: 50, height: 44, recommendedSize: 44 },
  };
  expect(matchNativeAuditFindings([hitRegion, issue], [button], [smallTarget])).toEqual([
    { ...issue, ref: '@e1', role: 'button', label: 'Save' },
  ]);
  const elsewhere = { ...smallTarget, rect: { ...rect, y: 200 } };
  expect(matchNativeAuditFindings([hitRegion], [button], [elsewhere])).toHaveLength(1);
  const otherKind: AuditFinding = {
    kind: 'missing-name',
    severity: 'warning',
    ref: '@e1',
    role: 'button',
    rect,
  };
  expect(matchNativeAuditFindings([hitRegion], [button], [otherKind])).toHaveLength(1);
});
