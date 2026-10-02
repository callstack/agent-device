import { describe, expect, test } from 'vitest';
import { SELECTOR_PIPELINE_POLICIES, readinessScheduleFor } from './selector-pipeline-policy.ts';

const promotedPoll = SELECTOR_PIPELINE_POLICIES.promotedTarget.poll;

describe('readinessScheduleFor', () => {
  test('polls at the row cadence with the supplied budget, counted from the first capture', () => {
    expect(readinessScheduleFor(promotedPoll, 800)).toEqual({
      intervalMs: promotedPoll.intervalMs,
      budgetMs: 800,
      budgetFrom: 'first-capture',
    });
  });

  test('caps the supplied budget at the row ceiling', () => {
    expect(readinessScheduleFor(promotedPoll, promotedPoll.maxTimeoutMs + 5_000)?.budgetMs).toBe(
      promotedPoll.maxTimeoutMs,
    );
  });

  test('a row that resolves against one capture has no schedule', () => {
    expect(readinessScheduleFor(SELECTOR_PIPELINE_POLICIES.resolvedTarget.poll, 800)).toBe(
      undefined,
    );
  });

  test.each([undefined, 0, -1, 1.5])('a %s budget takes the one-attempt path', (budget) => {
    expect(readinessScheduleFor(promotedPoll, budget)).toBe(undefined);
  });
});
