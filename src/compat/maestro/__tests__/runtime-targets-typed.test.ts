import { expect, test } from 'vitest';
import { resolveMaestroTargetFromSnapshot } from '../runtime-targets.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

test('typed target resolution returns target geometry and structured evidence', () => {
  const snapshot = makeSnapshot([
    {
      index: 1,
      type: 'Button',
      identifier: 'continue',
      label: 'Continue',
      rect: { x: 24, y: 100, width: 180, height: 48 },
      enabled: true,
      selected: false,
    },
  ]);

  const result = resolveMaestroTargetFromSnapshot(
    snapshot,
    { selector: { id: 'continue', enabled: true } },
    'ios',
  );

  expect(result).toMatchObject({
    ok: true,
    node: { index: 1 },
    rect: { x: 24, y: 100, width: 180, height: 48 },
    matches: 1,
    evidence: {
      selector: { id: 'continue', enabled: true },
      matched: true,
      visible: true,
      candidateCount: 1,
      ref: 'e1',
    },
  });
});

test('typed target resolution applies typed childOf and reports structured misses', () => {
  const snapshot = makeSnapshot([
    { index: 1, identifier: 'row', rect: { x: 0, y: 0, width: 320, height: 80 } },
    {
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Delete',
      rect: { x: 220, y: 16, width: 64, height: 48 },
    },
  ]);

  const result = resolveMaestroTargetFromSnapshot(
    snapshot,
    { selector: { text: 'Delete' }, childOf: { id: 'row' } },
    'android',
  );
  const missingParent = resolveMaestroTargetFromSnapshot(
    snapshot,
    { selector: { text: 'Delete' }, childOf: { id: 'missing' } },
    'android',
  );

  expect(result).toMatchObject({ ok: true, node: { index: 2 }, evidence: { candidateCount: 1 } });
  expect(missingParent).toMatchObject({
    ok: false,
    message: 'Maestro childOf parent did not match.',
    evidence: { matched: false, visible: false, candidateCount: 0 },
  });
});

test('typed childOf reports a scoped miss when only an outside child matches', () => {
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 320, height: 640 } },
    { index: 1, parentIndex: 0, identifier: 'row', rect: { x: 0, y: 0, width: 320, height: 80 } },
    {
      index: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Delete',
      rect: { x: 220, y: 96, width: 64, height: 48 },
    },
  ]);

  expect(
    resolveMaestroTargetFromSnapshot(
      snapshot,
      { selector: { text: 'Delete' }, childOf: { id: 'row' } },
      'android',
    ),
  ).toMatchObject({
    ok: false,
    message: 'Maestro selector did not match.',
    evidence: { matched: false, visible: false, candidateCount: 0 },
  });
});

test('keeps Maestro-visible app content matchable while a React Native overlay is present', () => {
  const snapshot = makeSnapshot([
    {
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Try Again',
      rect: { x: 149, y: 464, width: 94, height: 49 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'Other',
      label: 'Log 1 of 1',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Dismiss',
      rect: { x: 0, y: 770, width: 196, height: 48 },
    },
    {
      index: 4,
      parentIndex: 2,
      type: 'Other',
      label: 'Minimize',
      rect: { x: 196, y: 770, width: 197, height: 48 },
    },
  ]);

  expect(
    resolveMaestroTargetFromSnapshot(snapshot, { selector: { text: 'Try Again' } }, 'ios'),
  ).toMatchObject({
    ok: true,
    node: { index: 1 },
    evidence: { matched: true, visible: true, candidateCount: 1 },
  });
});

test('iOS target resolution selects a matching leaf through duplicate accessibility wrappers', () => {
  const snapshot = makeSnapshot([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Article',
      rect: { x: 0, y: 97, width: 393, height: 48 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'ScrollView',
      label: 'Article',
      rect: { x: 0, y: 97, width: 393, height: 48 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Article',
      rect: { x: -13.666, y: 97, width: 560, height: 48 },
    },
    {
      index: 4,
      depth: 4,
      parentIndex: 3,
      type: 'Other',
      label: 'Article',
      rect: { x: -3.666, y: 97, width: 120, height: 48 },
    },
  ]);

  expect(
    resolveMaestroTargetFromSnapshot(snapshot, { selector: { text: 'Article' } }, 'ios'),
  ).toMatchObject({
    ok: true,
    node: { index: 4 },
    rect: { x: -3.666, y: 97, width: 120, height: 48 },
    matches: 1,
  });
});

test('iOS target resolution preserves distinct nested controls matched by one expression', () => {
  const snapshot = makeSnapshot([
    {
      index: 0,
      type: 'Button',
      label: 'Save row',
      rect: { x: 16, y: 100, width: 200, height: 48 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Save action',
      rect: { x: 136, y: 100, width: 80, height: 48 },
    },
  ]);

  expect(
    resolveMaestroTargetFromSnapshot(snapshot, { selector: { text: 'Save.*' }, index: 1 }, 'ios'),
  ).toMatchObject({ ok: true, node: { index: 1 }, matches: 2 });
});
