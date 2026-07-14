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
    evidence: { matched: true, visible: false, candidateCount: 1 },
  });
});
