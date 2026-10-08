import { expect, test } from 'vitest';
import { maestroObservationMatches } from '../runtime-port-observation.ts';

const visibleCondition = { kind: 'visible' as const, selector: { text: 'Not Now' } };
const notVisibleCondition = {
  kind: 'notVisible' as const,
  selector: { text: 'Not Now' },
  timeoutMs: 0,
};

test('a visible condition requires an actionable resolution, not just matched evidence', () => {
  const resolved = { generation: 0, matched: true, visible: true, candidateCount: 1 };

  expect(maestroObservationMatches(visibleCondition, resolved)).toBe(true);
  // An out-of-range `index` over otherwise visible matches leaves matched and
  // visible evidence with no selected element; the condition must not hold.
  expect(
    maestroObservationMatches(visibleCondition, {
      ...resolved,
      failureReason: 'index-out-of-range',
    }),
  ).toBe(false);
  expect(
    maestroObservationMatches(visibleCondition, {
      ...resolved,
      matched: false,
      visible: false,
      failureReason: 'selector-did-not-match',
    }),
  ).toBe(false);
});

test('a notVisible condition is the strict complement of an actionable resolution', () => {
  const resolved = { generation: 0, matched: true, visible: true, candidateCount: 1 };

  expect(maestroObservationMatches(notVisibleCondition, resolved)).toBe(false);
  expect(
    maestroObservationMatches(notVisibleCondition, {
      ...resolved,
      failureReason: 'index-out-of-range',
    }),
  ).toBe(true);
  expect(
    maestroObservationMatches(notVisibleCondition, {
      ...resolved,
      matched: false,
      visible: false,
      failureReason: 'selector-did-not-match',
    }),
  ).toBe(true);
});
