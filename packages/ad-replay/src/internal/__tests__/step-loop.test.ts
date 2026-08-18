import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runAdReplay } from '../step-loop.ts';
import type { AdReplayStepRuntime } from '../runtime-port-types.ts';
import type { SessionAction } from '@agent-device/contracts/session';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';

/**
 * #1554 fold-in: `resolveSuppressedTerminalCloseIndex` (the pure structural
 * resolution `runAdReplay` uses for BOTH `--keep-session` and repair-armed
 * terminal-close suppression) is engine-private — never re-exported by the
 * façade (`packages/ad-replay/src/index.ts`) — so these tests exercise it
 * only through `runAdReplay` itself, the same way the daemon's own
 * `session-replay-runtime.ts` (`runReplayScriptSource`) does. The equivalent
 * daemon-level assertions (full `SessionStore`/`runReplayScriptSource` round
 * trip, including the `--keep-session` live-session postcondition) live in
 * `src/daemon/handlers/__tests__/session-replay-runtime-keep-session.test.ts`
 * (renamed from `session-replay-terminal-lifecycle.test.ts` by the #1555
 * structural-quality review — see that file's own header for the rationale);
 * this file covers the SAME suppression decision at the cheaper,
 * package-internal level, plus the repair-armed unification that file does
 * not exercise directly.
 */

function action(command: string, overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: 0, command, positionals: [], flags: {}, ...overrides };
}

/**
 * `runAdReplay`'s request, filled in with neutral `${VAR}`-plumbing fields —
 * every action in this file is untargeted and carries no `${VAR}` — so each
 * test only has to state what it actually varies (`actions`/`entryIndex`/
 * `keepSession`).
 */
function runRequest(
  actions: SessionAction[],
  overrides: { entryIndex?: number; keepSession: boolean },
) {
  return {
    actions,
    entryIndex: overrides.entryIndex ?? 0,
    keepSession: overrides.keepSession,
    actionLines: actions.map(() => 1),
    actionSourcePaths: undefined,
    resolvedPath: 'fixture.ad',
    varSources: {},
  };
}

/**
 * A minimal `AdReplayStepRuntime` fixture: every action in these tests is
 * untargeted (no `targetEvidence`), so `verifyAndDispatchStep` always takes
 * the `dispatchNoGuard` path straight to `dispatchStep` — the
 * target-verification capabilities are never called and just throw if they
 * somehow were.
 */
function createFakeRuntime(params: { isRepairArmed?: () => boolean } = {}): {
  runtime: AdReplayStepRuntime;
  dispatched: string[];
  armCount: () => number;
} {
  const dispatched: string[] = [];
  let armCount = 0;
  const runtime: AdReplayStepRuntime = {
    beginTargetVerification: () => ({ kind: 'inactive' }),
    captureObservation: async () => {
      throw new Error('captureObservation: not used by this fixture (no targetEvidence)');
    },
    classifyTarget: () => {
      throw new Error('classifyTarget: not used by this fixture (no targetEvidence)');
    },
    async dispatchStep(dispatchedAction, _resolvedAction, _index, artifactPaths) {
      dispatched.push(dispatchedAction.command);
      return { status: 'ok', artifactPaths };
    },
    buildRecordedUnverifiableFailure: async () => {
      throw new Error('buildRecordedUnverifiableFailure: not used by this fixture');
    },
    buildTargetBindingFailure: async () => {
      throw new Error('buildTargetBindingFailure: not used by this fixture');
    },
    buildPostDispatchTargetBindingFailure: async () => {
      throw new Error('buildPostDispatchTargetBindingFailure: not used by this fixture');
    },
    handleActionFailure: async () => {
      throw new Error('handleActionFailure: not used by this fixture (no failing step)');
    },
    armStep: () => {
      armCount += 1;
    },
    isRepairArmed: params.isRepairArmed ?? (() => false),
    describeStepValue: () => undefined,
    diagnosticsMarker: () => 0,
    diagnosticsSince: () => [],
  };
  return { runtime, dispatched, armCount: () => armCount };
}

test('--keep-session suppresses a close that is terminal among executable actions', async () => {
  // The trailing `replay "./nested.ad"` line is plan metadata
  // (`isExecutableReplayAction` skips it) — the true terminal step is `close`
  // at index 1, not the array's physical last index.
  const actions = [action('open'), action('close'), action('replay')];
  const { runtime, dispatched } = createFakeRuntime();
  const outcome = await runAdReplay(runRequest(actions, { keepSession: true }), runtime);
  assert.deepEqual(dispatched, ['open']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 1);
});

test('repair-armed suppresses the same terminal-among-executable close (unified decision)', async () => {
  const actions = [action('open'), action('close'), action('replay')];
  const { runtime, dispatched } = createFakeRuntime({ isRepairArmed: () => true });
  const outcome = await runAdReplay(runRequest(actions, { keepSession: false }), runtime);
  assert.deepEqual(dispatched, ['open']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 1);
});

test('an interior close is preserved instead of broad command filtering', async () => {
  const actions = [action('open'), action('close'), action('open')];
  const { runtime, dispatched } = createFakeRuntime();
  const outcome = await runAdReplay(runRequest(actions, { keepSession: true }), runtime);
  assert.deepEqual(dispatched, ['open', 'close', 'open']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 3);
});

test('a terminal close dispatches normally when neither keepSession nor repair is armed', async () => {
  const actions = [action('open'), action('close')];
  const { runtime, dispatched } = createFakeRuntime();
  const outcome = await runAdReplay(runRequest(actions, { keepSession: false }), runtime);
  assert.deepEqual(dispatched, ['open', 'close']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 2);
});

test('a close-less plan suppresses nothing and arms every executable step, including the suppressed one', async () => {
  const actions = [action('open'), action('close'), action('replay')];
  const { runtime, armCount } = createFakeRuntime();
  await runAdReplay(runRequest(actions, { keepSession: true }), runtime);
  // `armStep` runs before the terminal-close check so `[open, close]` records
  // the session `open` created before treating `close` as lifecycle — the
  // suppressed `close` is still armed, just never dispatched.
  assert.equal(armCount(), 2);
});

/**
 * #1555 P5 stage R3 invariant: `buildPostDispatchTargetBindingFailure`'s
 * `artifactPaths` argument is the run's accumulated PRE-step snapshot — the
 * same value `verifyAndDispatchStep`/`dispatchWithGuard` were called with —
 * never the artifacts the just-failed dispatch itself produced. A dispatch
 * that races a post-resolution refusal (guard-mismatch/landmark-mismatch)
 * may have taken its own screenshot as part of resolving (or failing to
 * resolve) the action; that capture belongs to the failed attempt, not to
 * the divergence report, which describes the screen BEFORE the action ran.
 */
test("a post-dispatch target-binding mismatch reports the pre-step artifact snapshot, not the failed dispatch's own", async () => {
  const recorded: TargetAnnotationV1 = {
    role: 'button',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  };
  const openAction = action('open');
  const waitAction: SessionAction = {
    ...action('wait'),
    targetEvidence: recorded,
  };

  let receivedArtifactPaths: readonly string[] | undefined;
  const runtime: AdReplayStepRuntime = {
    // Only `waitAction` carries `targetEvidence`, so this is only ever
    // called for it — routed to the #1349 deferred-landmark path, which
    // dispatches with a guard WITHOUT any capture/classify round trip.
    beginTargetVerification: () => ({ kind: 'post-resolution', isSelectorWait: true }),
    captureObservation: async () => {
      throw new Error(
        'captureObservation: not used — deferred-landmark skips straight to dispatch',
      );
    },
    classifyTarget: () => {
      throw new Error('classifyTarget: not used — deferred-landmark skips straight to dispatch');
    },
    async dispatchStep(dispatchedAction, _resolvedAction, _index, artifactPaths, _guard) {
      if (dispatchedAction.command === 'open') {
        return { status: 'ok', artifactPaths: ['open-snapshot.png'] };
      }
      // The wait's own dispatch attempt produced a DIFFERENT artifact set
      // than the pre-step snapshot it was called with (`artifactPaths`,
      // asserted below never to leak into the divergence report).
      assert.deepEqual(artifactPaths, ['open-snapshot.png']);
      return {
        status: 'landmark-mismatch',
        evidence: { matchCount: undefined, observed: undefined, observedAncestry: [] },
        plainFailure: { kind: 'REPLAY_DIVERGENCE', message: 'mismatch', artifactPaths: [] },
        artifactPaths: ['open-snapshot.png', 'post-dispatch-only.png'],
      };
    },
    buildRecordedUnverifiableFailure: async () => {
      throw new Error('buildRecordedUnverifiableFailure: not used by this fixture');
    },
    buildTargetBindingFailure: async () => {
      throw new Error(
        'buildTargetBindingFailure: not used by this fixture (this is a POST-dispatch mismatch)',
      );
    },
    async buildPostDispatchTargetBindingFailure(
      _dispatchedAction,
      _index,
      _evidence,
      artifactPaths,
      _scrubVars,
    ) {
      receivedArtifactPaths = artifactPaths;
      return { kind: 'REPLAY_DIVERGENCE', message: 'mismatch', artifactPaths: [] };
    },
    handleActionFailure: async ({ artifactPaths }) => ({
      kind: 'REPLAY_DIVERGENCE',
      message: 'mismatch',
      artifactPaths: [...artifactPaths],
    }),
    armStep: () => {},
    isRepairArmed: () => false,
    describeStepValue: () => undefined,
    diagnosticsMarker: () => 0,
    diagnosticsSince: () => [],
  };

  const outcome = await runAdReplay(
    runRequest([openAction, waitAction], { keepSession: false }),
    runtime,
  );

  assert.equal(outcome.status, 'failed');
  // The divergence reports the snapshot taken BEFORE the wait's dispatch —
  // `open`'s own artifact, nothing the failed dispatch itself produced.
  assert.deepEqual(receivedArtifactPaths, ['open-snapshot.png']);
});
