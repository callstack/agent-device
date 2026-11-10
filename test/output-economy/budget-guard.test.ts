import { describe, expect, test } from 'vitest';
import type { EconomyMetrics } from './economy-metrics.ts';
import { findEconomyBudgetIncreases } from './budget-guard.ts';

const metrics = (bytes: number, lines = 1): EconomyMetrics => ({
  bytes,
  lines,
  refs: 1,
  hints: 0,
  shape: 'fixture',
});

describe('monotonic output budget guard', () => {
  test('rejects same-PR baseline byte and line increases', () => {
    expect(
      findEconomyBudgetIncreases({ snapshot: metrics(100, 4) }, { snapshot: metrics(101, 5) }, {}),
    ).toEqual([
      { sample: 'snapshot', metric: 'bytes', previous: 100, current: 101 },
      { sample: 'snapshot', metric: 'lines', previous: 4, current: 5 },
    ]);
  });

  test('accepts reductions and new measured surfaces', () => {
    expect(
      findEconomyBudgetIncreases(
        { snapshot: metrics(100, 4) },
        { snapshot: metrics(90, 3), mcp: metrics(300) },
        {},
      ),
    ).toEqual([]);
  });

  test('requires an exact reviewed waiver with a reason', () => {
    const base = { snapshot: metrics(100) };
    const candidate = { snapshot: metrics(110) };

    expect(
      findEconomyBudgetIncreases(base, candidate, {
        snapshot: {
          bytes: { from: 100, to: 110 },
          reason: 'Structured output gained a required recovery handle.',
        },
      }),
    ).toEqual([]);
    expect(
      findEconomyBudgetIncreases(base, candidate, {
        snapshot: { bytes: { from: 100, to: 111 }, reason: 'Wrong proposed ceiling.' },
      }),
    ).toHaveLength(1);
    expect(
      findEconomyBudgetIncreases(base, candidate, {
        snapshot: { bytes: { from: 100, to: 110 }, reason: '   ' },
      }),
    ).toHaveLength(1);
  });

  test('a spent waiver cannot excuse a later return to its ceiling', () => {
    // The waiver raised 100 -> 110 and the floor later shrank to 50: the same ceiling is a new raise.
    expect(
      findEconomyBudgetIncreases(
        { snapshot: metrics(50) },
        { snapshot: metrics(110) },
        {
          snapshot: {
            bytes: { from: 100, to: 110 },
            reason: 'Raise reviewed against the old floor.',
          },
        },
      ),
    ).toEqual([{ sample: 'snapshot', metric: 'bytes', previous: 50, current: 110 }]);
  });

  test('rejects silently removing a measured surface', () => {
    expect(findEconomyBudgetIncreases({ snapshot: metrics(100) }, {}, {})).toEqual([
      { sample: 'snapshot', metric: 'sample', previous: 1, current: 0 },
    ]);
  });
});
