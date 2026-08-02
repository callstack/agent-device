import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runAdReplay, type AdReplayStepRuntime } from '../step-loop.ts';
import type { SessionAction } from '@agent-device/contracts/session';
import type { ReplaySelectorPort } from '../selector-port.ts';

/**
 * #1554 fold-in: `resolveSuppressedTerminalCloseIndex` (the pure structural
 * resolution `runAdReplay` uses for BOTH `--keep-session` and repair-armed
 * terminal-close suppression) is engine-private — never re-exported by the
 * façade (`packages/ad-replay/src/index.ts`) — so these tests exercise it
 * only through `runAdReplay` itself, the same way the daemon's own
 * `session-replay-runtime.ts` (`runReplayScriptFile`) does. The equivalent
 * daemon-level assertions (full `SessionStore`/`runReplayScriptFile` round
 * trip, including the `--keep-session` live-session postcondition) live in
 * `src/daemon/handlers/__tests__/session-replay-terminal-lifecycle.test.ts`;
 * this file covers the SAME suppression decision at the cheaper,
 * package-internal level, plus the repair-armed unification that file does
 * not exercise directly.
 */

function action(command: string, overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: 0, command, positionals: [], flags: {}, ...overrides };
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
    port: {} as ReplaySelectorPort,
    beginTargetVerification: () => ({ kind: 'inactive' }),
    captureObservation: async () => {
      throw new Error('captureObservation: not used by this fixture (no targetEvidence)');
    },
    classifyTarget: () => {
      throw new Error('classifyTarget: not used by this fixture (no targetEvidence)');
    },
    async dispatchStep(dispatchedAction, _index, artifactPaths) {
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
  const outcome = await runAdReplay({ actions, entryIndex: 0, keepSession: true }, runtime);
  assert.deepEqual(dispatched, ['open']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 1);
});

test('repair-armed suppresses the same terminal-among-executable close (unified decision)', async () => {
  const actions = [action('open'), action('close'), action('replay')];
  const { runtime, dispatched } = createFakeRuntime({ isRepairArmed: () => true });
  const outcome = await runAdReplay({ actions, entryIndex: 0, keepSession: false }, runtime);
  assert.deepEqual(dispatched, ['open']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 1);
});

test('an interior close is preserved instead of broad command filtering', async () => {
  const actions = [action('open'), action('close'), action('open')];
  const { runtime, dispatched } = createFakeRuntime();
  const outcome = await runAdReplay({ actions, entryIndex: 0, keepSession: true }, runtime);
  assert.deepEqual(dispatched, ['open', 'close', 'open']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 3);
});

test('a terminal close dispatches normally when neither keepSession nor repair is armed', async () => {
  const actions = [action('open'), action('close')];
  const { runtime, dispatched } = createFakeRuntime();
  const outcome = await runAdReplay({ actions, entryIndex: 0, keepSession: false }, runtime);
  assert.deepEqual(dispatched, ['open', 'close']);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.replayed, 2);
});

test('a close-less plan suppresses nothing and arms every executable step, including the suppressed one', async () => {
  const actions = [action('open'), action('close'), action('replay')];
  const { runtime, armCount } = createFakeRuntime();
  await runAdReplay({ actions, entryIndex: 0, keepSession: true }, runtime);
  // `armStep` runs before the terminal-close check so `[open, close]` records
  // the session `open` created before treating `close` as lifecycle — the
  // suppressed `close` is still armed, just never dispatched.
  assert.equal(armCount(), 2);
});
