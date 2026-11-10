import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  matchesAuthorizedPressTarget,
  type AuthorizedPressTarget,
} from './selector-observation-runtime.ts';

// Shared with the native mutation-read: identity or capture geometry changes must never rebind input.
const cases = JSON.parse(
  readFileSync(
    new URL('../../../contracts/fixtures/authorized-press-target.json', import.meta.url),
    'utf8',
  ),
) as {
  name: string;
  expected: AuthorizedPressTarget;
  candidate: AuthorizedPressTarget;
  matches: boolean;
}[];
for (const fixture of cases) {
  test(`authorized native target parity: ${fixture.name}`, () => {
    expect(matchesAuthorizedPressTarget(fixture.expected, fixture.candidate)).toBe(fixture.matches);
  });
}
