import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { ObservationClock } from './observe-until.ts';
import {
  formatPostGestureOutcomeWarning,
  runPostGestureStabilityLoop,
  type PostGestureBaseline,
  type PostGesturePreActionBaseline,
  type PostGestureStabilityDecision,
  type PostGestureStabilityHooks,
  type PostGestureStabilityPending,
} from './post-gesture-stability.ts';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

beforeEach(() => {
  vi.mocked(emitDiagnostic).mockClear();
});

type Surface = Readonly<{
  signature: readonly string[];
  costMs: number;
  backend?: string;
  firstScreenContent?: number;
}>;

// The negative half of these lines is type-level: each @ts-expect-error fails `pnpm typecheck`
// the moment the baseline union would accept a post-action reading as pre-action evidence again
// (#3868). The pre-action-only slots are the pending record's baseline and the accept-stale
// payload; only the writer may fill them.
test('the baseline union rejects a post-action reading in every pre-action slot', () => {
  const postAction: PostGestureBaseline<readonly string[]> = {
    provenance: 'post-action',
    signature: ['a'],
    comparisonKey: 'key',
  };
  // @ts-expect-error a rebased baseline is not pre-action evidence for the pending record
  const pendingBaseline: PostGesturePreActionBaseline<readonly string[]> = postAction;
  const pending: PostGestureStabilityPending<readonly string[]> = {
    action: 'scroll',
    positionals: ['down'],
    // @ts-expect-error a rebased baseline is not pre-action evidence for the pending record
    baseline: postAction,
  };
  const decision = undefined as unknown as PostGestureStabilityDecision<readonly string[]>;
  const consumeDistrust = () => {
    if (decision.verdict === 'distrust') {
      // @ts-expect-error a distrust decision exposes no pre-action baseline to consume
      void decision.preActionBaseline;
    }
  };
  // @ts-expect-error a baseline is constructed complete: the comparison key is not optional
  const keyless: PostGesturePreActionBaseline<readonly string[]> = {
    provenance: 'pre-action',
    signature: ['a'],
  };

  void [pendingBaseline, pending, keyless, decision, consumeDistrust];
});

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
    readSurface: (value) => ({
      signature: value.signature,
      comparisonKey: value.backend ?? 'xctest',
    }),
    signaturesStable: same,
    classifyBaselineEvidence: (baseline, quiet) =>
      same(baseline.signature, quiet.signature) ? 'unchanged' : 'changed',
    surfacesIdentical: same,
    summarizeDivergence: () => ({}),
    countFirstScreenContent: (value) => value.firstScreenContent ?? 20,
  };
}

const PENDING = { action: 'scroll', positionals: ['down'] };

function preActionBaseline(
  signature: readonly string[],
  comparisonKey: string,
): PostGesturePreActionBaseline<readonly string[]> {
  return { provenance: 'pre-action', signature, comparisonKey };
}

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
    pending: { ...PENDING, baseline: preActionBaseline(['moved'], 'runner') },
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
    pending: { ...PENDING, baseline: preActionBaseline(['before'], 'bridge') },
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

test('an effect that lands after a rebase keeps the loop polling until the moved surface is quiet', async () => {
  const clock = fakeClock();
  const rebasedRead: Surface = { signature: ['before'], costMs: 0, backend: 'bridge' };
  const moving: Surface = { signature: ['moving'], costMs: 0, backend: 'bridge' };
  const moved: Surface = { signature: ['moved'], costMs: 0, backend: 'bridge' };

  const outcome = await runPostGestureStabilityLoop({
    pending: { ...PENDING, baseline: preActionBaseline(['before'], 'runner') },
    hooks: hooksFor(clock, [rebasedRead, rebasedRead, moving, moved, moved]),
    clock,
  });

  assert.equal(outcome.value, moved);
  assert.equal(outcome.postGestureOutcome, undefined);
  assert.equal(diagnostics('post_gesture_snapshot_baseline_rebased').length, 1);
  assert.equal(diagnostics('post_gesture_snapshot_stale_accept').length, 0);
});

// --- first-screen readiness after an app launch ---

const LAUNCH = { action: 'open', positionals: [], readiness: 'first-screen' as const };

function launchSurface(name: string, contentNodes: number, costMs = 50): Surface {
  return {
    signature: [name, String(contentNodes)],
    costMs,
    firstScreenContent: contentNodes,
  };
}

test('a launch keeps polling through a quiet loading tree until the first screen appears', async () => {
  const clock = fakeClock();
  const loading = launchSurface('loading', 0);
  const home = launchSurface('home', 20);

  const outcome = await runPostGestureStabilityLoop({
    pending: LAUNCH,
    hooks: hooksFor(clock, [...Array.from({ length: 12 }, () => loading), home, home]),
    clock,
  });

  assert.equal(outcome.value, home);
  assert.equal(outcome.postGestureOutcome, undefined);
  assert.ok(clock.now() > 1_500, `a quiet loading tree settled after ${clock.now()}ms`);
});

test('a launch that reads a populated first screen returns on its first quiet pair', async () => {
  const clock = fakeClock();
  const home = launchSurface('home', 20);

  const outcome = await runPostGestureStabilityLoop({
    pending: LAUNCH,
    hooks: hooksFor(clock, [home, home]),
    clock,
  });

  assert.equal(outcome.value, home);
  assert.equal(outcome.postGestureOutcome, undefined);
  assert.ok(clock.now() < 500, `settled after ${clock.now()}ms`);
});

test('a sparse first screen settles once it stays unchanged, far inside the launch budget', async () => {
  const clock = fakeClock();
  const oneButton = launchSurface('one-button', 1);

  const outcome = await runPostGestureStabilityLoop({
    pending: LAUNCH,
    hooks: hooksFor(
      clock,
      Array.from({ length: 20 }, () => oneButton),
    ),
    clock,
  });

  assert.equal(outcome.value, oneButton);
  assert.equal(outcome.postGestureOutcome, undefined);
  assert.ok(clock.now() >= 1_500, `a sparse tree settled after only ${clock.now()}ms`);
  assert.ok(clock.now() < 2_500, `a sparse tree waited ${clock.now()}ms`);
});

test('a sparse tree that keeps changing does not settle on a quiet pair', async () => {
  const clock = fakeClock();
  const progress = [10, 10, 40, 40, 70, 70, 100, 100].map((percent) =>
    launchSurface(`downloading ${percent}%`, 1),
  );
  const home = launchSurface('home', 20);

  const outcome = await runPostGestureStabilityLoop({
    pending: LAUNCH,
    hooks: hooksFor(clock, [...progress, home, home]),
    clock,
  });

  assert.equal(outcome.value, home);
});

test('a launch whose budget expires on a loading tree reports the app as loading', async () => {
  const clock = fakeClock();
  const loading = launchSurface('loading', 0);

  const outcome = await runPostGestureStabilityLoop({
    pending: LAUNCH,
    hooks: hooksFor(
      clock,
      Array.from({ length: 60 }, () => loading),
    ),
    clock,
  });

  assert.equal(outcome.value, loading);
  assert.deepEqual(outcome.postGestureOutcome, {
    kind: 'loading',
    gesture: { action: 'open', positionals: [] },
  });
  assert.ok(clock.now() >= 10_000 && clock.now() < 10_500, `gave up after ${clock.now()}ms`);
  assert.match(formatPostGestureOutcomeWarning(outcome.postGestureOutcome!), /still loading/);
});

test('a launch whose populated tree never quiets reports it unsettled, not loading', async () => {
  const clock = fakeClock();
  const frames = Array.from({ length: 60 }, (_, frame) => launchSurface(`frame ${frame}`, 20));

  const outcome = await runPostGestureStabilityLoop({
    pending: LAUNCH,
    hooks: hooksFor(clock, frames),
    clock,
  });

  assert.equal(outcome.postGestureOutcome?.kind, 'unsettled');
});

test('a gesture record never applies the first-screen rule to an empty tree', async () => {
  const clock = fakeClock();
  const empty = launchSurface('empty', 0);

  const outcome = await runPostGestureStabilityLoop({
    pending: PENDING,
    hooks: hooksFor(clock, [empty, empty]),
    clock,
  });

  assert.equal(outcome.value, empty);
  assert.equal(outcome.postGestureOutcome, undefined);
});
