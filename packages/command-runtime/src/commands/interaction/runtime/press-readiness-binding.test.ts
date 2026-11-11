import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { matchesAuthorizedPressTarget } from './press-readiness-binding.ts';
import type { SnapshotNativePressTarget } from '@agent-device/kernel/snapshot';

// Shared with the native mutation-read: identity or capture geometry changes must never rebind input.
const cases = JSON.parse(
  readFileSync(
    new URL('../../../../../../contracts/fixtures/authorized-press-target.json', import.meta.url),
    'utf8',
  ),
) as {
  name: string;
  expected: SnapshotNativePressTarget;
  candidate: SnapshotNativePressTarget;
  matches: boolean;
}[];
for (const fixture of cases) {
  test(`authorized native target parity: ${fixture.name}`, () => {
    expect(matchesAuthorizedPressTarget(fixture.expected, fixture.candidate)).toBe(fixture.matches);
  });
}

// JSON cannot encode non-finite numbers; both language consumers exercise them natively.
for (const field of ['x', 'y', 'width', 'height'] as const) {
  test(`non-finite native ${field} never establishes a binding`, () => {
    const { expected, candidate } = cases[0]!;
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      const rect = { ...candidate.rect, [field]: value };
      expect(matchesAuthorizedPressTarget(expected, { ...candidate, rect })).toBe(false);
      expect(matchesAuthorizedPressTarget({ ...expected, rect }, { ...candidate, rect })).toBe(
        false,
      );
    }
  });
}

for (const type of ['SearchField', 'TextField', 'SecureTextField', 'TextView']) {
  test(`canonical ${type} binding excludes mutable contents`, () => {
    const expected = { type, label: 'Input', value: 'before', rect: cases[0]!.expected.rect };
    const candidate = { ...expected, value: 'after' };
    expect(matchesAuthorizedPressTarget(expected, candidate)).toBe(true);
    expect(matchesAuthorizedPressTarget(expected, { ...candidate, label: 'Replacement' })).toBe(
      false,
    );
  });
}
