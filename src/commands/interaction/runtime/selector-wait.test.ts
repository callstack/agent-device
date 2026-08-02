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
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import {
  createFakeClock,
  createSelectorDevice,
  selectorReadSnapshot,
} from './__tests__/test-utils/index.ts';

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
// #1478 P5 step 2, cell 7: wait-landmark identity mismatch (#1349's
// `recordedLandmark`). This is the root seam the future `resolveRecordedTarget`
// port must preserve — a selector match alone is not enough; the wait only
// reports success once SOME match carries the recorded landmark identity, and
// a deadline with only impostor matches must surface the
// `WAIT_LANDMARK_MISMATCH_REASON` refusal rather than either succeeding or an
// undifferentiated timeout.
// ---------------------------------------------------------------------------

function screenNodes(parentLabel: string) {
  return [
    {
      index: 0,
      depth: 0,
      type: 'FrameLayout',
      label: parentLabel,
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'TextView',
      label: 'Screen X',
      rect: { x: 0, y: 100, width: 390, height: 40 },
    },
  ];
}

function recordedLandmark(): TargetAnnotationV1 {
  return {
    role: 'textview',
    label: 'Screen X',
    ancestry: [{ role: 'framelayout', label: 'Detail Screen' }],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  };
}

test('P5 port cell 7: a landmark wait succeeds once a poll carries the recorded identity, not on the first same-selector match', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => {
        calls += 1;
        // First poll: an impostor screen — same selector match ("Screen X"),
        // wrong ancestor label, so the recorded landmark's ancestry prefix
        // does not match. Second poll: the real destination screen.
        const nodes = makeSnapshotState(
          calls === 1 ? screenNodes('List Screen') : screenNodes('Detail Screen'),
        );
        return { snapshot: nodes };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: makeSnapshotState([]) }]),
    policy: localCommandPolicy(),
    clock,
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: {
      kind: 'selector',
      selector: 'label="Screen X"',
      timeoutMs: 5000,
      recordedLandmark: recordedLandmark(),
    },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') return;
  assert.equal(result.node?.label, 'Screen X');
  assert.ok(calls >= 2, `must not report success on the impostor's own poll, got ${calls} polls`);
  assert.ok(result.waitedMs > 0, 'must have advanced past the impostor poll');
});

test('P5 port cell 7: a landmark wait refuses at the deadline with WAIT_LANDMARK_MISMATCH_REASON when every poll is an impostor', async () => {
  const clock = createFakeClock();
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => ({ snapshot: makeSnapshotState(screenNodes('List Screen')) }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: makeSnapshotState([]) }]),
    policy: localCommandPolicy(),
    clock,
  });

  await assert.rejects(
    () =>
      device.selectors.wait({
        session: 'default',
        target: {
          kind: 'selector',
          selector: 'label="Screen X"',
          timeoutMs: 250,
          recordedLandmark: recordedLandmark(),
        },
      }),
    (error: unknown) => {
      const details = (error as { details?: { reason?: string; matchCount?: number } }).details;
      assert.equal(details?.reason, 'wait_landmark_identity_mismatch');
      // The selector itself matched (one impostor node) — this must not be
      // reported as an ordinary selector-not-found timeout.
      assert.equal(details?.matchCount, 1);
      return true;
    },
  );
});
