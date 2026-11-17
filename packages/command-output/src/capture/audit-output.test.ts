import { expect, test } from 'vitest';
import type { AuditSnapshotCommandResult } from '@agent-device/contracts/capture';
import { auditCliOutput } from './audit-output.ts';

const CHECKS = { snapshot: 'complete' } as const;

test('renders warnings and observations as aligned lines with the advisory wording', () => {
  const result: AuditSnapshotCommandResult = {
    findings: [
      {
        kind: 'small-target',
        severity: 'warning',
        ref: '@e7',
        role: 'button',
        label: 'Save Lemon Herb Rice',
        detail: { unit: 'pt', width: 22, height: 22.5, recommendedSize: 44 },
      },
      {
        kind: 'missing-name',
        severity: 'warning',
        ref: '@e9',
        role: 'text-field',
        identifier: 'email',
      },
      {
        kind: 'covered-control',
        severity: 'observation',
        ref: '@e12',
        role: 'button',
      },
    ],
    guidance: {},
    checks: CHECKS,
    limitations: [],
    refsGeneration: 3,
  };
  expect(auditCliOutput(result).text).toBe(
    [
      'agent-device audit',
      '2 warnings, 1 observation — current screen',
      '@e7~s3   small-target     button "Save Lemon Herb Rice"  22×22.5pt, below 44×44pt',
      '@e9~s3   missing-name     text-field id="email"  No accessible name',
      '@e12~s3  covered-control  button  Accessible action is unavailable to touch',
      '',
    ].join('\n'),
  );
});

test('prints plain refs when the result carries no generation to pin them to', () => {
  const output = auditCliOutput({
    findings: [{ kind: 'missing-name', severity: 'warning', ref: '@e9', role: 'button' }],
    guidance: {},
    checks: CHECKS,
    limitations: [],
  });
  expect(output.text).toContain('@e9  missing-name');
  expect(output.text).not.toContain('~s');
});

test('says no findings and lists each limitation', () => {
  const output = auditCliOutput({
    findings: [],
    guidance: {},
    checks: CHECKS,
    limitations: ['Target size was not checked: tv targets are focus-driven.'],
  });
  expect(output.text).toBe(
    [
      'agent-device audit',
      'No findings — current screen',
      '',
      'Limitation: Target size was not checked: tv targets are focus-driven.',
      '',
    ].join('\n'),
  );
});

test('keeps the structured result as the JSON payload', () => {
  const result: AuditSnapshotCommandResult = {
    findings: [],
    guidance: {},
    checks: CHECKS,
    limitations: [],
  };
  expect(auditCliOutput(result).data).toBe(result);
});

test('prints each guidance entry once after the findings and preserves it in JSON', () => {
  const result: AuditSnapshotCommandResult = {
    findings: [1, 2].map((index) => ({
      kind: 'missing-name',
      severity: 'warning',
      ref: `@e${index}`,
      role: 'button',
    })),
    guidance: { 'missing-name': 'Set an accessibility label.' },
    checks: CHECKS,
    limitations: [],
  };
  const output = auditCliOutput(result);
  expect(output.text).toContain('button  No accessible name');
  expect(output.text!.split('missing-name: Set an accessibility label.')).toHaveLength(2);
  expect(output.text!.indexOf('missing-name:')).toBeGreaterThan(output.text!.indexOf('@e2'));
  expect(output.data).toBe(result);
});
