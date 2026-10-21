import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { ObservationClock } from './observe-until.ts';
import {
  runPostGestureStabilityLoop,
  type PostGestureStabilityHooks,
} from './post-gesture-stability.ts';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

beforeEach(() => {
  vi.mocked(emitDiagnostic).mockClear();
});

type Surface = Readonly<{ signature: readonly string[]; costMs: number; backend?: string }>;

function fakeClock(): ObservationClock & { advance(ms: number): void } {
  let nowMs = 0;
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
    sleep: async (ms) => {
      nowMs += ms;
    },
  };
}

/** Captures that each cost their own `costMs` of clock time and ignore any signal. */
function hooksFor(
  clock: ReturnType<typeof fakeClock>,
  surfaces: readonly Surface[],
): PostGestureStabilityHooks<Surface, readonly string[]> {
  let calls = 0;
  const same = (a: readonly string[], b: readonly string[]) => a.join() === b.join();
  return {
    capture: async () => {
      const surface = surfaces[calls];
      calls += 1;
      if (!surface) throw new Error('the loop captured more surfaces than the case supplied');
      clock.advance(surface.costMs);
      return surface;
    },
    readSurface: (value) => ({ signature: value.signature, backend: value.backend ?? 'xctest' }),
    signaturesStable: same,
    classifyBaselineEvidence: (baseline, quiet) =>
      same(baseline, quiet) ? 'unchanged' : 'changed',
    surfacesIdentical: same,
    summarizeDivergence: () => ({}),
  };
}

const PENDING = { action: 'scroll', positionals: ['down'] };

function diagnostics(phase: string): unknown[] {
  return vi.mocked(emitDiagnostic).mock.calls.filter(([event]) => event.phase === phase);
}

function timeoutWarnings(): unknown[] {
  return diagnostics('post_gesture_snapshot_stabilization_timeout');
}

test('a capture that runs past the remaining budget is judged and ends unsettled, not thrown', async () => {
  const clock = fakeClock();
  const late: Surface = { signature: ['b'], costMs: 2_000 };

  const outcome = await runPostGestureStabilityLoop({
    pending: PENDING,
    needsBaselineDistrust: false,
    hooks: hooksFor(clock, [{ signature: ['a'], costMs: 0 }, late]),
    clock,
  });

  assert.equal(outcome.value, late);
  assert.deepEqual(outcome.postGestureOutcome, {
    kind: 'unsettled',
    gesture: { action: 'scroll', positionals: ['down'] },
  });
  assert.equal(timeoutWarnings().length, 1);
});

test('a first capture slower than the whole budget still forms a quiet pair', async () => {
  const clock = fakeClock();
  const quiet: Surface = { signature: ['a'], costMs: 0 };

  const outcome = await runPostGestureStabilityLoop({
    pending: PENDING,
    needsBaselineDistrust: false,
    hooks: hooksFor(clock, [{ signature: ['a'], costMs: 2_000 }, quiet]),
    clock,
  });

  assert.equal(outcome.value, quiet);
  assert.equal(outcome.postGestureOutcome, undefined);
  assert.equal(timeoutWarnings().length, 0);
});

test('a capture error ends the loop by rethrowing that error', async () => {
  const clock = fakeClock();
  const failure = new Error('capture failed');
  const hooks = hooksFor(clock, []);

  await assert.rejects(
    runPostGestureStabilityLoop({
      pending: PENDING,
      needsBaselineDistrust: false,
      hooks: {
        ...hooks,
        capture: async () => {
          throw failure;
        },
      },
      clock,
    }),
    (error) => error === failure,
  );
});

test('a quiet pair on a rebased baseline settles instead of distrusting it to the cap', async () => {
  const clock = fakeClock();
  const atRest: Surface = { signature: ['moved'], costMs: 0, backend: 'bridge' };

  const outcome = await runPostGestureStabilityLoop({
    pending: { ...PENDING, baselineSignature: ['moved'], baselineBackend: 'runner' },
    needsBaselineDistrust: true,
    hooks: hooksFor(clock, [atRest, atRest, atRest]),
    clock,
  });

  assert.equal(outcome.value, atRest);
  assert.equal(outcome.postGestureOutcome, undefined);
  assert.equal(diagnostics('post_gesture_snapshot_baseline_rebased').length, 1);
  assert.equal(diagnostics('post_gesture_snapshot_stale_accept').length, 0);
  assert.ok(clock.now() < 1_500, `settled after ${clock.now()}ms`);
});

test('a quiet pair matching a same-backend baseline is still distrusted to the cap', async () => {
  const clock = fakeClock();
  const unchanged: Surface = { signature: ['before'], costMs: 0, backend: 'bridge' };

  await runPostGestureStabilityLoop({
    pending: { ...PENDING, baselineSignature: ['before'], baselineBackend: 'bridge' },
    needsBaselineDistrust: true,
    hooks: hooksFor(
      clock,
      Array.from({ length: 40 }, () => unchanged),
    ),
    clock,
  });

  assert.equal(diagnostics('post_gesture_snapshot_baseline_rebased').length, 0);
  assert.equal(diagnostics('post_gesture_snapshot_stale_accept').length, 1);
  assert.ok(clock.now() >= 3_500, `accepted after ${clock.now()}ms`);
});
