import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { SnapshotDiffLine } from '@agent-device/contracts/capture';
import type { CliJsonResult } from '../cli-json.ts';
import type { AndroidLiveHarness, LiveContext } from './live-harness.ts';
import { waitForSnapshotDiffLines } from './live-snapshot-transition.ts';

const CONTEXT = {} as LiveContext;
const TRANSITION = [
  { kind: 'removed', text: 'Open automation alert' },
  { kind: 'added', text: 'Open automation lab' },
] as const;

// The diff the lane read before Back had rendered Settings: the automation route, slightly changed.
const STILL_AUTOMATION: SnapshotDiffLine[] = [
  { kind: 'unchanged', text: '@e19 [button] "Open automation alert"' },
  { kind: 'removed', text: '@e20 [text] "Open automation alert"' },
  { kind: 'unchanged', text: '@e20 [text] "Alert result: accepted"' },
];
const NOW_SETTINGS: SnapshotDiffLine[] = [
  { kind: 'removed', text: '@e19 [button] "Open automation alert"' },
  { kind: 'added', text: '@e4 [button] "Open automation lab"' },
];
const NOTHING_CHANGED: SnapshotDiffLine[] = [
  { kind: 'unchanged', text: '@e19 [button] "Open automation alert"' },
];

/** A scripted `diff snapshot`: entry `attempt - 1` answers, the last entry repeats. */
function scriptedDiffs(script: SnapshotDiffLine[][]): {
  runStep: AndroidLiveHarness['runStep'];
  steps: string[];
} {
  const steps: string[] = [];
  const runStep: AndroidLiveHarness['runStep'] = async (_context, step, args) => {
    expect(args).toEqual(['diff', 'snapshot', '-i']);
    steps.push(step);
    const lines = script[Math.min(steps.length - 1, script.length - 1)]!;
    return { status: 0, stdout: '', stderr: '', json: { success: true, data: { lines } } };
  };
  return { runStep, steps };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]).then(([result]) => result);
  await vi.runAllTimersAsync();
  return settled;
}

test('a diff read before the destination rendered is followed by the diff that reports it', async () => {
  const { runStep, steps } = scriptedDiffs([STILL_AUTOMATION, NOW_SETTINGS]);
  const result = await settle(waitForSnapshotDiffLines(CONTEXT, runStep, 'observe', TRANSITION));

  expect(result.status).toBe('fulfilled');
  expect(steps).toEqual(['observe (attempt 1)', 'observe (attempt 2)']);
});

test('a transition that already rendered is reported by the first diff', async () => {
  const { runStep, steps } = scriptedDiffs([NOW_SETTINGS]);
  const result = await settle(waitForSnapshotDiffLines(CONTEXT, runStep, 'observe', TRANSITION));

  expect(result.status).toBe('fulfilled');
  expect(steps).toHaveLength(1);
});

test('a destination that never renders fails at the deadline and names the unreported line', async () => {
  const start = Date.now();
  const { runStep, steps } = scriptedDiffs([STILL_AUTOMATION, NOTHING_CHANGED]);
  const result = await settle(waitForSnapshotDiffLines(CONTEXT, runStep, 'observe', TRANSITION));

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /^expected added line containing Open automation lab within 10000ms: .*"unchanged"/s,
      ),
    },
  });
  expect(steps).toHaveLength(40);
  expect(Date.now() - start).toBe(10_000);
});

test('a diff without lines fails at once instead of waiting', async () => {
  const steps: string[] = [];
  const runStep: AndroidLiveHarness['runStep'] = async (_context, step) => {
    steps.push(step);
    const result: CliJsonResult = { status: 0, stdout: '', stderr: '', json: { success: true } };
    return result;
  };
  const result = await settle(waitForSnapshotDiffLines(CONTEXT, runStep, 'observe', TRANSITION));

  expect(result).toMatchObject({
    status: 'rejected',
    reason: { message: expect.stringMatching(/snapshot diff has no lines/) },
  });
  expect(steps).toHaveLength(1);
});
