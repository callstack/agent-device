import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { createFakeClock } from './__tests__/test-utils/index.ts';
import { computeTargetEvidence } from '../../../daemon/session-target-evidence.ts';
import { WAIT_LANDMARK_MISMATCH_REASON } from '@agent-device/contracts/replay';
import { AppError } from '@agent-device/kernel/errors';

test('runtime focused selector waits against a full snapshot', async () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Cell',
      label: 'Profiles and Accounts',
      focused: true,
    },
  ]);
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'selector', selector: 'focused=true', timeoutMs: 1000 },
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.selector, 'focused=true');
  assert.equal(result.waitedMs >= 0, true);
  assert.equal(captureOptions?.interactiveOnly, false);
});

// ---------------------------------------------------------------------------
// #1349 (relocated from `selector-read.test.ts` — this is the 1:1 topology
// location for `wait-selector.ts`, and #1478 P5 step 2 cell 7's pin):
// wait's in-loop landmark identity verification, threaded as
// `target.recordedLandmark`. Polling semantics are preserved — a
// same-selector impostor never aborts the wait; only the deadline turns
// rejected candidates into the fail-closed landmark refusal
// (`WAIT_LANDMARK_MISMATCH_REASON`), and a plain "the selector never matched
// at all" timeout stays undifferentiated. This is the root seam the future
// `resolveRecordedTarget` port operation must preserve.
// ---------------------------------------------------------------------------

function landmarkScreen(parentLabel: string) {
  return makeSnapshotState([
    { index: 0, depth: 0, type: 'Other', label: parentLabel },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Screen X',
      rect: { x: 0, y: 0, width: 100, height: 20 },
    },
  ]);
}

function recordedLandmarkFor(snapshot: ReturnType<typeof landmarkScreen>) {
  const node = snapshot.nodes[1]!;
  const evidence = computeTargetEvidence(
    { node, preActionNodes: snapshot.nodes },
    { mode: 'landmark' },
  );
  assert.ok(evidence);
  assert.equal(evidence.verification, 'verified');
  return evidence;
}

function landmarkWaitDevice(captures: Array<ReturnType<typeof landmarkScreen>>) {
  let call = 0;
  const initial = captures[0]!;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        const snapshot = captures[Math.min(call, captures.length - 1)]!;
        call += 1;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: initial }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
  return device;
}

/**
 * The within-one-poll twin of the test below (#1649 review P1): both
 * candidates are on screen in the SAME capture, impostor first. The landmark
 * check is satisfied when SOME match carries the recorded identity, so
 * resolution must hand it every candidate — a policy that returns only its
 * first-match winner would hide the genuine landmark behind the impostor and
 * make this wait time out.
 */
function twoCandidateScreen(): ReturnType<typeof landmarkScreen> {
  return makeSnapshotState([
    { index: 0, depth: 0, type: 'Other', label: 'List Screen' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Screen X',
      rect: { x: 0, y: 0, width: 100, height: 20 },
    },
    { index: 2, depth: 0, type: 'Other', label: 'Detail Screen' },
    {
      index: 3,
      depth: 1,
      parentIndex: 2,
      type: 'StaticText',
      label: 'Screen X',
      rect: { x: 0, y: 40, width: 100, height: 20 },
    },
  ]);
}

test('runtime wait finds the recorded landmark behind a same-selector impostor in one capture', async () => {
  const recorded = recordedLandmarkFor(landmarkScreen('Detail Screen'));
  const device = landmarkWaitDevice([twoCandidateScreen()]);

  const result = await device.selectors.wait({
    session: 'default',
    target: {
      kind: 'selector',
      selector: 'label="Screen X"',
      timeoutMs: 2_000,
      recordedLandmark: recorded,
    },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') throw new Error('unreachable');
  // The SECOND candidate is the one carrying the recorded ancestry.
  assert.equal(result.node?.index, 3);
});

test('runtime wait keeps polling past a same-selector impostor and succeeds on the recorded landmark', async () => {
  const recordTime = landmarkScreen('Detail Screen');
  const recorded = recordedLandmarkFor(recordTime);
  const impostor = landmarkScreen('List Screen');
  const empty = makeSnapshotState([{ index: 0, depth: 0, type: 'Other', label: 'Loading' }]);
  const device = landmarkWaitDevice([empty, impostor, landmarkScreen('Detail Screen')]);

  const result = await device.selectors.wait({
    session: 'default',
    target: {
      kind: 'selector',
      selector: 'label="Screen X"',
      timeoutMs: 10_000,
      recordedLandmark: recorded,
    },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') throw new Error('unreachable');
  // Two rejected polls (absent, then impostor) before the landmark appeared.
  assert.equal(result.waitedMs >= 600, true);
  assert.equal(result.node?.label, 'Screen X');
  assert.equal(result.preActionNodes?.length, 2);
});

test('runtime wait fails closed at the deadline when only impostors matched the selector', async () => {
  const recorded = recordedLandmarkFor(landmarkScreen('Detail Screen'));
  const device = landmarkWaitDevice([landmarkScreen('List Screen')]);

  const error = await device.selectors
    .wait({
      session: 'default',
      target: {
        kind: 'selector',
        selector: 'label="Screen X"',
        timeoutMs: 1000,
        recordedLandmark: recorded,
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.reason, WAIT_LANDMARK_MISMATCH_REASON);
  assert.equal(error.details?.matchCount, 1);
  const observed = error.details?.observed as { role: string; label?: string };
  assert.equal(observed.label, 'Screen X');
  const ancestry = error.details?.observedAncestry as Array<{ role: string; label?: string }>;
  assert.equal(ancestry[0]?.label, 'List Screen');
  assertReadablePollEvidence(error);
});

/** The refusal carries the same poll evidence a plain timeout would. */
function assertReadablePollEvidence(error: AppError): void {
  const details = error.details ?? {};
  const polls = details.polls as Array<{ outcome: string }>;
  assert.ok(polls.length >= 1);
  assert.ok(polls.every((poll) => poll.outcome === 'readable'));
  assert.equal(details.captures, polls.length);
  assert.equal(details.readableCaptures, polls.length);
  assert.equal(typeof details.waitedMs, 'number');
}

/**
 * An impostor capture, then a capture that outlives the deadline: the refusal still names the
 * landmark mismatch, and its poll timeline shows the deadline cutting the last capture short,
 * with the runner-restart evidence that capture carried.
 */
async function landmarkRefusalAfter(
  finalCapture: () => Promise<ReturnType<typeof landmarkScreen>>,
): Promise<AppError> {
  const recorded = recordedLandmarkFor(landmarkScreen('Detail Screen'));
  let call = 0;
  const impostor = landmarkScreen('List Screen');
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        call += 1;
        if (call === 1) return { snapshot: impostor };
        return { snapshot: await finalCapture() };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: impostor }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(100),
  });
  const error = await device.selectors
    .wait({
      session: 'default',
      target: {
        kind: 'selector',
        selector: 'label="Screen X"',
        timeoutMs: 400,
        recordedLandmark: recorded,
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(error instanceof AppError);
  assert.equal(error.details?.reason, WAIT_LANDMARK_MISMATCH_REASON);
  return error;
}

test('landmark refusal after a deadline-cancelled capture keeps the poll timeline', async () => {
  const error = await landmarkRefusalAfter(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return landmarkScreen('List Screen');
  });

  const polls = error.details?.polls as Array<{ outcome: string }>;
  assert.deepEqual(
    polls.map((poll) => poll.outcome),
    ['readable', 'deadline'],
  );
  assert.equal(error.details?.readableCaptures, 1);
  assert.equal(error.details?.captures, 2);
});

test('landmark refusal after a runner restart keeps the restart outcome', async () => {
  const error = await landmarkRefusalAfter(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    throw new AppError('COMMAND_FAILED', 'runner restarted', {
      runnerRestarted: true,
      runnerRestartReason: 'runner_readiness_preflight_failed_before_command_send',
    });
  });

  const polls = error.details?.polls as Array<{ outcome: string }>;
  assert.deepEqual(
    polls.map((poll) => poll.outcome),
    ['readable', 'runner-restart'],
  );
  assert.equal(error.details?.runnerRestarted, true);
  assert.equal(
    error.details?.runnerRestartReason,
    'runner_readiness_preflight_failed_before_command_send',
  );
});

test('runtime wait with a recorded landmark keeps the plain timeout when the selector never matched', async () => {
  const recorded = recordedLandmarkFor(landmarkScreen('Detail Screen'));
  const empty = makeSnapshotState([{ index: 0, depth: 0, type: 'Other', label: 'Loading' }]);
  const device = landmarkWaitDevice([empty]);

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: {
        kind: 'selector',
        selector: 'label="Screen X"',
        timeoutMs: 1000,
        recordedLandmark: recorded,
      },
    }),
    (thrown: unknown) => {
      assert.ok(thrown instanceof AppError);
      assert.match(thrown.message, /wait timed out for selector/);
      assert.equal(thrown.details?.reason, 'wait_target_absent');
      assert.equal((thrown.details?.readableCaptures as number) > 0, true);
      assert.equal(typeof thrown.details?.waitedMs, 'number');
      return true;
    },
  );
});

test('runtime wait with no capture evidence never reports target absence', async () => {
  const device = landmarkWaitDevice([landmarkScreen('Detail Screen')]);

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 0 },
    }),
    (thrown: unknown) => {
      assert.ok(thrown instanceof AppError);
      assert.equal(thrown.details?.reason, 'wait_capture_stalled');
      assert.equal(thrown.details?.retriable, true);
      assert.equal(thrown.details?.readableCaptures, 0);
      return true;
    },
  );
});

test('runtime wait without a recorded landmark returns the satisfying match for record-time evidence', async () => {
  const device = landmarkWaitDevice([landmarkScreen('Detail Screen')]);

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 1000 },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') throw new Error('unreachable');
  assert.equal(result.node?.label, 'Screen X');
  assert.equal(result.preActionNodes?.length, 2);
});
