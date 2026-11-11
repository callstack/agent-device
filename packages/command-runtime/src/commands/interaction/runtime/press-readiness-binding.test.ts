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

test('equal reported values cannot rebind across producer value views', () => {
  const source = { ...cases[0]!.expected, type: 49, value: 'Hint' };
  const accessibility = { ...source, valueSource: 'accessibility' as const };
  expect(matchesAuthorizedPressTarget(source, accessibility)).toBe(false);
  expect(matchesAuthorizedPressTarget(accessibility, source)).toBe(false);
  expect(matchesAuthorizedPressTarget(accessibility, accessibility)).toBe(true);
  const unknown = { ...source, valueSource: 'unknown' } as unknown as SnapshotNativePressTarget;
  expect(matchesAuthorizedPressTarget(unknown, unknown)).toBe(false);
});
