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
        detail: { unit: 'pt', width: 22, height: 22.5, recommendedSize: 44 },
      },
      {
        kind: 'missing-name',
        severity: 'warning',
        ref: '@e9',
        role: 'text-field',
      },
      {
        kind: 'covered-control',
        severity: 'observation',
        ref: '@e12',
        role: 'button',
      },
    ],
    checks: CHECKS,
    limitations: [],
    refsGeneration: 3,
  };
  expect(auditCliOutput(result).text).toBe(
    [
      'agent-device audit',
      '2 warnings, 1 observation — current screen',
      '@e7~s3   small-target     22×22.5pt; review touch area',
      '@e9~s3   missing-name     Text field has no accessible name',
      '@e12~s3  covered-control  Accessible action is unavailable to touch',
      '',
    ].join('\n'),
  );
});

test('prints plain refs when the result carries no generation to pin them to', () => {
  const output = auditCliOutput({
    findings: [{ kind: 'missing-name', severity: 'warning', ref: '@e9', role: 'button' }],
    checks: CHECKS,
    limitations: [],
  });
  expect(output.text).toContain('@e9  missing-name');
  expect(output.text).not.toContain('~s');
});

test('says no findings and lists each limitation', () => {
  const output = auditCliOutput({
    findings: [],
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
  const result: AuditSnapshotCommandResult = { findings: [], checks: CHECKS, limitations: [] };
  expect(auditCliOutput(result).data).toBe(result);
});
