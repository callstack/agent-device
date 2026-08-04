import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import {
  createFakeClock,
  createSelectorDevice,
  selectorReadSnapshot,
} from './__tests__/test-utils/index.ts';
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

test('runtime wait can use backend text search', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), {
    findText: true,
    now: 10,
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Ready', timeoutMs: 100 },
  });

  assert.deepEqual(result, { kind: 'text', text: 'Ready', waitedMs: 0 });
});

// ---------------------------------------------------------------------------
// #1349 (relocated from `selector-read.test.ts` — this is the 1:1 topology
// location for `selector-wait.ts`, and #1478 P5 step 2 cell 7's pin):
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
      (thrown: unknown) => thrown,
    );

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.reason, WAIT_LANDMARK_MISMATCH_REASON);
  assert.equal(error.details?.matchCount, 1);
  const observed = error.details?.observed as { role: string; label?: string };
  assert.equal(observed.label, 'Screen X');
  const ancestry = error.details?.observedAncestry as Array<{ role: string; label?: string }>;
  assert.equal(ancestry[0]?.label, 'List Screen');
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
