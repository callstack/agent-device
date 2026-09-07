import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { SnapshotCaptureAnnotations } from '@agent-device/contracts/capture';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';
import { captureFreshnessRecoveredAttempt } from '../snapshot-freshness/recovery.ts';
import type {
  SnapshotFreshnessReason,
  SnapshotFreshnessWindow,
} from '../snapshot-freshness/types.ts';

type Attempt = {
  snapshot: ReturnType<typeof makeSnapshotState>;
  annotations: SnapshotCaptureAnnotations;
};

function attempt(): Attempt {
  return { snapshot: makeSnapshotState([]), annotations: {} };
}

function windowMarkedAt(markedAt: number): SnapshotFreshnessWindow {
  return { action: 'click', markedAt, baselineCount: 50, routeComparable: false };
}

/** Classifies the first `suspiciousCount` attempts as stale, then reports trustworthy. */
function classifierFailingFirst(suspiciousCount: number) {
  let seen = 0;
  return () => {
    seen += 1;
    return (seen <= suspiciousCount ? 'sharp-drop' : null) as SnapshotFreshnessReason | null;
  };
}

test('a trustworthy first capture retires the window and annotates nothing', async () => {
  let retired = 0;
  let captures = 0;
  const result = await captureFreshnessRecoveredAttempt({
    capture: async () => {
      captures += 1;
      return attempt();
    },
    classify: () => null,
    window: windowMarkedAt(Date.now()),
    retry: { retryBudgetMs: 1_500, delaysMs: [250, 400, 600] },
    onTrustworthyCapture: () => {
      retired += 1;
    },
  });

  assert.equal(captures, 1);
  assert.equal(retired, 1);
  assert.equal(result.annotations.freshness, undefined);
});

test('a suspicious capture that recovers discloses the retry count and retires the window', async () => {
  vi.useFakeTimers();
  try {
    const markedAt = Date.now();
    let retired = 0;
    let captures = 0;
    const pending = captureFreshnessRecoveredAttempt({
      capture: async () => {
        captures += 1;
        return attempt();
      },
      classify: classifierFailingFirst(1),
      window: windowMarkedAt(markedAt),
      retry: { retryBudgetMs: 1_500, delaysMs: [250, 400, 600] },
      onTrustworthyCapture: () => {
        retired += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await pending;

    assert.equal(captures, 2);
    assert.equal(retired, 1);
    // `reason` is carried as an explicit undefined when the capture recovered, which is what the
    // pre-facet annotation did too — asserted rather than trimmed so a change to it is visible.
    assert.deepEqual(result.annotations.freshness, {
      action: 'click',
      retryCount: 1,
      staleAfterRetries: false,
      reason: undefined,
    });
  } finally {
    vi.useRealTimers();
  }
});

test('a capture still suspicious after every delay keeps the window and names the reason', async () => {
  vi.useFakeTimers();
  try {
    const markedAt = Date.now();
    let retired = 0;
    let captures = 0;
    const pending = captureFreshnessRecoveredAttempt({
      capture: async () => {
        captures += 1;
        return attempt();
      },
      classify: () => 'stuck-route' as const,
      window: windowMarkedAt(markedAt),
      retry: { retryBudgetMs: 1_500, delaysMs: [250, 400, 600] },
      onTrustworthyCapture: () => {
        retired += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await pending;

    // The initial capture plus all three delays fit inside the 1.5 s budget.
    assert.equal(captures, 4);
    assert.equal(retired, 0, 'a still-suspicious capture must leave the window standing');
    assert.deepEqual(result.annotations.freshness, {
      action: 'click',
      retryCount: 3,
      staleAfterRetries: true,
      reason: 'stuck-route',
    });
  } finally {
    vi.useRealTimers();
  }
});

/**
 * The invariant: the deadline is derived from the window's `markedAt` plus the budget, never from
 * when the loop happened to start. A window whose budget was already spent before the loop ran
 * therefore gets its one capture and no retries.
 */
test('a budget already spent before the loop started runs the capture once and no retries', async () => {
  let captures = 0;
  const markedAt = Date.now() - 10_000;
  const result = await captureFreshnessRecoveredAttempt({
    capture: async () => {
      captures += 1;
      return attempt();
    },
    classify: () => 'sharp-drop' as const,
    window: windowMarkedAt(markedAt),
    retry: { retryBudgetMs: 1_500, delaysMs: [250, 400, 600] },
  });

  assert.equal(captures, 1);
  assert.deepEqual(result.annotations.freshness, {
    action: 'click',
    retryCount: 0,
    staleAfterRetries: true,
    reason: 'sharp-drop',
  });
});

test('the same budget retries or not depending only on how old the window is', async () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    async function retriesFor(markedAt: number): Promise<number> {
      let captures = 0;
      const pending = captureFreshnessRecoveredAttempt({
        capture: async () => {
          captures += 1;
          return attempt();
        },
        classify: () => 'sharp-drop' as const,
        window: windowMarkedAt(markedAt),
        retry: { retryBudgetMs: 1_500, delaysMs: [250, 400, 600] },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      return captures - 1;
    }

    // Identical budget, identical delays — only `markedAt` differs, and that alone decides
    // whether any retry fits. A loop that measured its budget from its own start would return
    // the same count for both.
    assert.equal(await retriesFor(now), 3);
    assert.equal(await retriesFor(now - 1_500), 0);
  } finally {
    vi.useRealTimers();
  }
});
