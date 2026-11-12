import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import type { Point } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createAgentDevice } from '../../../runtime.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { ref, selector } from './selector-read-utils.ts';

// ADR 0039 admission on the press route: what an idle target pays, and how the request budget ends a
// motion wait. Each scenario drives `press` through the command surface with a scripted backend and
// a scenario clock; the motion check's own judgements stay in `moving-target-gate.test.ts`.

const BUTTON_Y = 240;

function slideTree(x: number): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'App',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Slide target',
      rect: { x, y: BUTTON_Y, width: 120, height: 50 },
      hittable: true,
    },
  ]);
}

/**
 * A press route whose backend answers captures from `trees` (the last one repeats). `baselineAgeMs`
 * leaves a just-finished mutation on the session, whose tree shows the target at x=-400. Each
 * capture takes `captureMs` of scenario time.
 */
function createAdmissionDevice(params: {
  platform: NonNullable<AgentDeviceBackend['platform']>;
  trees: SnapshotState[];
  baselineAgeMs?: number;
  baselineTree?: SnapshotState;
  captureMs?: number;
  onSleep?: () => void;
  onCapture?: (capture: number) => void;
}) {
  let nowMs = 0;
  const sleeps: number[] = [];
  const captureStarts: number[] = [];
  const taps: Point[] = [];
  const clock = {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
      params.onSleep?.();
    },
  };
  const backend: AgentDeviceBackend = {
    platform: params.platform,
    captureSnapshot: async () => {
      captureStarts.push(nowMs);
      nowMs += params.captureMs ?? 0;
      const snapshot = params.trees[Math.min(captureStarts.length - 1, params.trees.length - 1)]!;
      params.onCapture?.(captureStarts.length);
      return { snapshot };
    },
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
  };
  const stored = params.trees[0]!;
  const device = createAgentDevice({
    backend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      {
        name: 'default',
        snapshot: stored,
        ...(params.baselineAgeMs === undefined
          ? {}
          : {
              movingTargetBaseline: {
                finishedAt: -params.baselineAgeMs,
                tree: { nodes: (params.baselineTree ?? slideTree(-400)).nodes },
              },
            }),
      },
    ]),
    policy: localCommandPolicy(),
    clock,
  });
  return {
    device,
    sleeps,
    captureStarts,
    taps,
    now: () => nowMs,
  };
}

function assertCanceledBeforeDispatch(error: unknown): true {
  assert.ok(isRequestCanceledError(error), `expected a canceled request, got ${String(error)}`);
  assert.equal((error as { details?: Record<string, unknown> }).details?.dispatched, 'no');
  return true;
}

function assertDeadlineBeforeDispatch(error: unknown): true {
  const details = (error as { details?: Record<string, unknown> }).details;
  assert.equal(details?.reason, 'daemon_request_timeout', String(error));
  assert.equal(details?.dispatched, 'no');
  return true;
}

for (const history of [
  { name: 'no mutation history', baselineAgeMs: undefined },
  { name: 'a mutation outside the window', baselineAgeMs: 5_000 },
  { name: 'a target the previous action left in place', baselineAgeMs: 100, stationary: true },
] as const) {
  test(`an idle press after ${history.name} pays no extra capture or sleep`, async () => {
    for (const target of ['selector', 'ref'] as const) {
      const harness = createAdmissionDevice({
        platform: 'android',
        trees: [slideTree(10)],
        baselineAgeMs: history.baselineAgeMs,
        ...('stationary' in history ? { baselineTree: slideTree(10) } : {}),
      });

      await harness.device.interactions.press(
        target === 'selector' ? selector('label="Slide target"') : ref('@e2'),
        { session: 'default' },
      );

      assert.deepEqual(harness.taps, [{ x: 70, y: BUTTON_Y + 25 }], target);
      // A selector spends its resolution capture; a ref resolves against its stored tree.
      assert.equal(harness.captureStarts.length, target === 'selector' ? 1 : 0, target);
      assert.deepEqual(harness.sleeps, [], target);
    }
  });
}

test('a cancellation during the wait for the first look sends no input', async () => {
  const controller = new AbortController();
  const harness = createAdmissionDevice({
    platform: 'ios',
    trees: [slideTree(240), slideTree(10)],
    baselineAgeMs: 100,
    onSleep: () => controller.abort(),
  });

  await assert.rejects(
    () =>
      harness.device.interactions.press(selector('label="Slide target"'), {
        session: 'default',
        signal: controller.signal,
      }),
    assertCanceledBeforeDispatch,
  );
  assert.equal(harness.captureStarts.length, 1, 'no look after the cancellation');
  assert.deepEqual(harness.taps, []);
});

test('a cancellation during a look sends no input, even when the look shows rest', async () => {
  const controller = new AbortController();
  const harness = createAdmissionDevice({
    // The second look agrees with the first, which would admit the target on iOS.
    platform: 'ios',
    trees: [slideTree(240), slideTree(10)],
    baselineAgeMs: 100,
    onCapture: (capture) => {
      if (capture === 3) controller.abort();
    },
  });

  await assert.rejects(
    () =>
      harness.device.interactions.press(selector('label="Slide target"'), {
        session: 'default',
        signal: controller.signal,
      }),
    assertCanceledBeforeDispatch,
  );
  assert.equal(harness.captureStarts.length, 3, 'the look in flight is the last one');
  assert.deepEqual(harness.taps, []);
});

test('the request deadline ends a motion wait that the window would continue', async () => {
  const deadlineAtMs = Date.now() + 1_000;
  const harness = createAdmissionDevice({
    platform: 'android',
    // Never quiet: the 1.5 s Android window alone would keep looking past the request deadline.
    trees: Array.from({ length: 100 }, (_, index) => slideTree(index % 2 === 0 ? 240 : 10)),
    baselineAgeMs: 0,
  });

  await assert.rejects(
    () =>
      harness.device.interactions.press(selector('label="Slide target"'), {
        session: 'default',
        deadlineAtMs,
      }),
    assertDeadlineBeforeDispatch,
  );
  assert.ok(harness.captureStarts.length > 3, 'the wait looked until the budget ran out');
  assert.ok(harness.now() < 1_000, `no sleep crossed the deadline (ended at ${harness.now()})`);
  assert.ok(harness.captureStarts.every((startedAt) => startedAt < 1_000));
  assert.deepEqual(harness.taps, []);
});

test('a request deadline before the window ends refuses without sleeping or looking', async () => {
  const deadlineAtMs = Date.now() + 200;
  const harness = createAdmissionDevice({
    platform: 'ios',
    trees: [slideTree(240), slideTree(10)],
    baselineAgeMs: 0,
  });

  await assert.rejects(
    () =>
      harness.device.interactions.press(selector('label="Slide target"'), {
        session: 'default',
        deadlineAtMs,
      }),
    assertDeadlineBeforeDispatch,
  );
  assert.deepEqual(harness.sleeps, []);
  assert.equal(harness.captureStarts.length, 1, 'only the resolution capture');
  assert.deepEqual(harness.taps, []);
});

test('an Android target that stops late in the window gets a full sample gap before it closes', async () => {
  // Captures take 60 ms and the window gives up 300 ms after the screening. The target stops in
  // the third look, which ends 20 ms before give-up: the next look still comes one full sample gap
  // later, so the position holds for the 100 ms quiet interval and the press dispatches.
  const harness = createAdmissionDevice({
    platform: 'android',
    trees: [slideTree(240), slideTree(200), slideTree(150), slideTree(10)],
    baselineAgeMs: 1_140,
    captureMs: 60,
  });

  await harness.device.interactions.press(selector('label="Slide target"'), { session: 'default' });

  assert.deepEqual(harness.taps, [{ x: 70, y: BUTTON_Y + 25 }]);
  assert.deepEqual(harness.captureStarts, [0, 60, 170, 280, 390]);
});

test('a missing ref keeps its resolution refusal ahead of a canceled request', async () => {
  // ADR 0014 precedence: admission runs after resolution, so a ref the frame cannot name reports
  // that, not the cancellation that admission would have reported.
  const controller = new AbortController();
  controller.abort();
  const harness = createAdmissionDevice({
    platform: 'android',
    trees: [slideTree(10)],
    baselineAgeMs: 100,
  });

  await assert.rejects(
    () =>
      harness.device.interactions.press(ref('@e9'), {
        session: 'default',
        signal: controller.signal,
      }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, INTERACTION_ERROR_REASONS.refNotFound);
      return true;
    },
  );
  assert.deepEqual(harness.taps, []);
});
