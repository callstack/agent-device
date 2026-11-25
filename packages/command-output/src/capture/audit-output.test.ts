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
      '@e7-s3   small-target     button "Save Lemon Herb Rice"  22×22.5pt, below 44×44pt',
      '@e9-s3   missing-name     text-field id="email"  No accessible name',
      '@e12-s3  covered-control  button  Accessible action is unavailable to touch',
      '',
    ].join('\n'),
  );
});

test('renders an ambiguous-name line with the shared label and the count', () => {
  const result: AuditSnapshotCommandResult = {
    findings: [
      {
        kind: 'ambiguous-name',
        severity: 'warning',
        ref: '@e4',
        role: 'button',
        label: 'Save',
        detail: { name: 'Save', count: 3 },
      },
    ],
    guidance: {
      'ambiguous-name':
        'Give each control a unique label that names its target, for example "Save Lemon Herb Rice".',
    },
    checks: CHECKS,
    limitations: [],
  };
  expect(auditCliOutput(result).text).toBe(
    [
      'agent-device audit',
      '1 warning — current screen',
      '@e4  ambiguous-name  button "Save"  Name shared by 3 controls of this role',
      '',
      'ambiguous-name: Give each control a unique label that names its target, for example "Save Lemon Herb Rice".',
      '',
    ].join('\n'),
  );
});

test('names an ambiguous control that takes its name from a child or content description', () => {
  const output = auditCliOutput({
    findings: [
      {
        kind: 'ambiguous-name',
        severity: 'warning',
        ref: '@e7',
        role: 'button',
        detail: { name: 'Add to cart', count: 2 },
      },
    ],
    guidance: {},
    checks: CHECKS,
    limitations: [],
  });
  expect(output.text).toContain(
    '@e7  ambiguous-name  button "Add to cart"  Name shared by 2 controls of this role',
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
  expect(output.text).not.toMatch(/@e\d+-s\d/);
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

test('prints native descriptions and point geometry alongside unchanged heuristic lines', () => {
  const result = {
    findings: [
      { kind: 'missing-name', severity: 'warning', ref: '@e1', role: 'button' },
      {
        source: 'native',
        kind: 'native',
        severity: 'warning',
        platform: 'ios',
        auditType: 'contrast',
        description: 'Low contrast',
        rect: { x: 335.6666666666667, y: 811, width: 17.333333314, height: 22 },
        ref: '@e2',
        role: 'button',
        label: 'Dictate',
      },
      {
        source: 'native',
        kind: 'native',
        severity: 'warning',
        platform: 'ios',
        auditType: 'dynamicType',
        description: 'Does not scale',
      },
    ],
    guidance: {},
    checks: CHECKS,
    limitations: [],
    refsGeneration: 2,
  } satisfies AuditSnapshotCommandResult;
  expect(auditCliOutput(result).text).toBe(
    [
      'agent-device audit',
      '3 warnings — current screen',
      '@e1-s2  missing-name  button  No accessible name',
      'native  contrast  Low contrast  @e2-s2 button "Dictate"  [335.7,811 17.3×22]',
      'native  dynamicType  Does not scale',
      '',
    ].join('\n'),
  );
  expect(auditCliOutput(result).data).toEqual(result);
});
