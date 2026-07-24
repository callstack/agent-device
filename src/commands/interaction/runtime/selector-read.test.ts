import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
  type CommandSessionStore,
} from '../../../runtime.ts';
import { ref, selector } from './selector-read.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import {
  createFakeClock,
  createSelectorDevice,
  selectorReadSnapshot,
} from './__tests__/test-utils/index.ts';
import { computeTargetEvidence } from '../../../daemon/session-target-evidence.ts';
import { WAIT_LANDMARK_MISMATCH_REASON } from '../../../replay/target-identity-node.ts';
import { AppError } from '../../../kernel/errors.ts';

test('runtime get reads text from a selector target', async () => {
  const snapshot = selectorReadSnapshot();
  const device = createSelectorDevice(snapshot, {
    readText: 'Backend expanded text',
  });

  const result = await device.selectors.get({
    session: 'default',
    property: 'text',
    target: { kind: 'selector', selector: 'label=Continue' },
  });

  assert.equal(result.kind, 'text');
  assert.deepEqual(result.target, { kind: 'selector', selector: 'label=Continue' });
  assert.equal(result.text, 'Backend expanded text');
  assert.equal(result.node.label, 'Continue');
  assert.deepEqual(result.selectorChain, [
    'role="button" label="Continue"',
    'label="Continue"',
    'value="Continue"',
  ]);
});

test('runtime get selector target captures fresh snapshot without a stored session snapshot', async () => {
  const snapshot = selectorReadSnapshot();
  const sessions = createMemorySessionStore([{ name: 'default' }]);
  let captures = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        captures += 1;
        return { snapshot };
      },
      readText: async () => ({ text: 'Fresh text' }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.getText(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'Fresh text');
  assert.equal(captures, 1);
  assert.equal((await sessions.get('default'))?.snapshot?.nodes[0]?.label, 'Continue');
});

test('runtime get returns attrs for a ref target without recapturing', async () => {
  const snapshot = selectorReadSnapshot();
  let captures = 0;
  const device = createSelectorDevice(snapshot, {
    captureSnapshot: () => {
      captures += 1;
      return { snapshot };
    },
  });

  const result = await device.selectors.get({
    session: 'default',
    property: 'attrs',
    target: { kind: 'ref', ref: '@e1' },
  });

  assert.equal(result.kind, 'attrs');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e1' });
  assert.equal(result.node.label, 'Continue');
  assert.equal(captures, 0);
});

test('runtime selectors pass runtime signal to backend snapshot capture', async () => {
  const snapshot = selectorReadSnapshot();
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (context) => {
        signal = context.signal;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    signal: controller.signal,
  });

  const result = await device.selectors.getAttrs(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'attrs');
  assert.equal(signal, controller.signal);
});

test('runtime selectors forward public snapshot options to backend capture', async () => {
  const snapshot = selectorReadSnapshot();
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

  await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label=Continue',
    depth: 2,
    scope: 'Login',
    raw: true,
  });

  assert.deepEqual(captureOptions, {
    interactiveOnly: false,
    depth: 2,
    scope: 'Login',
    raw: true,
    includeRects: false,
  });
});

test('runtime visibility predicates request snapshot rects', async () => {
  const snapshot = selectorReadSnapshot();
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'web',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  await device.selectors.isVisible(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(captureOptions?.includeRects, true);
});

test('runtime focused predicate requests a full snapshot', async () => {
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

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'focused',
    selector: 'role=cell label="Profiles and Accounts"',
  });

  assert.equal(result.pass, true);
  assert.equal(captureOptions?.interactiveOnly, false);
});

test('runtime focused predicate reads focused Android TV nodes from the full tree', async () => {
  const fullSnapshot = makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'TextView',
        label: 'Featured',
        focused: true,
        hittable: false,
      },
    ],
    { backend: 'android' },
  );
  const interactiveSnapshot = makeSnapshotState([], { backend: 'android' });
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot: options?.interactiveOnly ? interactiveSnapshot : fullSnapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: interactiveSnapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'focused',
    selector: 'label=Featured',
  });

  assert.equal(result.pass, true);
  assert.equal(captureOptions?.interactiveOnly, false);
});

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

test('runtime is validates selector predicates', async () => {
  const device = createSelectorDevice(selectorReadSnapshot());

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label=Continue',
  });

  assert.deepEqual(result, {
    predicate: 'exists',
    pass: true,
    selector: 'label=Continue',
    matches: 1,
    selectorChain: ['label=Continue'],
  });
});

test('runtime find get_text reads the matched node', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), {
    readText: 'Continue',
  });

  const result = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Continue',
    action: 'get_text',
  });

  assert.equal(result.kind, 'text');
  assert.equal(result.ref, '@e1');
  assert.equal(result.text, 'Continue');
  assert.equal(result.node.label, 'Continue');
});

test('runtime find accepts selector expression queries', async () => {
  const device = createSelectorDevice(selectorReadSnapshot());

  const result = await device.selectors.find({
    session: 'default',
    query: 'label="Continue"',
    action: 'exists',
  });

  assert.deepEqual(result, { kind: 'found', found: true });
});

test('runtime web find text does not pass locator text as browser selector scope', async () => {
  const snapshot = selectorReadSnapshot();
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'web',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Continue',
    action: 'exists',
  });

  assert.deepEqual(result, { kind: 'found', found: true });
  assert.equal(captureOptions?.scope, undefined);
});

test('runtime find wait reports sparse snapshot verdicts on the selector-read route', async () => {
  const initialSnapshot = selectorReadSnapshot();
  const session = { name: 'default', snapshot: initialSnapshot };
  const sessions = {
    get: () => session,
    set: (record) => {
      session.snapshot = record.snapshot ?? session.snapshot;
    },
  } satisfies CommandSessionStore;
  const sparseSnapshot = makeSnapshotState([
    {
      index: 0,
      type: 'Application',
    },
  ]);
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({
        nodes: sparseSnapshot.nodes,
        backend: 'xctest',
        quality: {
          state: 'sparse',
          backend: 'private-ax',
          reason: 'sparse tree',
          reasonCode: 'sparse-tree',
        },
      }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
    clock: {
      now: () => 0,
      sleep: async () => {},
    },
  });

  await assert.rejects(
    () =>
      device.selectors.find({
        session: 'default',
        locator: 'text',
        query: 'Never appears',
        action: 'wait',
        timeoutMs: 100,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'find could not read the current accessibility tree' &&
      (error as { details?: { reason?: string } }).details?.reason === 'sparse tree',
  );
  assert.equal(session.snapshot, initialSnapshot);
});

test('runtime find wait skips hidden-content hint derivation on every poll (#1270)', async () => {
  // A `wait`'s presence check never consumes scroll hints, so every poll must ask the capture
  // layer to skip deriving them — otherwise a single pathological `dumpsys activity top` call
  // can eat the whole wait budget from inside this loop.
  const snapshot = selectorReadSnapshot();
  const captureOptionsCalls: Array<BackendSnapshotOptions | undefined> = [];
  let elapsed = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (_context, options) => {
        captureOptionsCalls.push(options);
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    clock: {
      now: () => elapsed,
      sleep: async () => {
        elapsed += 300;
      },
    },
  });

  await assert.rejects(
    () =>
      device.selectors.find({
        session: 'default',
        locator: 'text',
        query: 'Never appears',
        action: 'wait',
        timeoutMs: 500,
      }),
    /find wait timed out/,
  );

  assert.equal(captureOptionsCalls.length >= 2, true);
  for (const options of captureOptionsCalls) {
    assert.equal(options?.includeHiddenContentHints, false);
  }
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

test('runtime selector convenience methods use explicit target helpers', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), {
    readText: 'Continue',
    findText: true,
  });

  const text = await device.selectors.getText(selector('label=Continue'), { session: 'default' });
  const attrs = await device.selectors.getAttrs(ref('@e1'), { session: 'default' });
  const visible = await device.selectors.isVisible(selector('label=Continue'), {
    session: 'default',
  });
  const waited = await device.selectors.waitForText('Ready', {
    session: 'default',
    timeoutMs: 100,
  });

  assert.equal(text.kind, 'text');
  assert.equal(attrs.kind, 'attrs');
  assert.equal(visible.pass, true);
  assert.deepEqual(waited, { kind: 'text', text: 'Ready', waitedMs: 0 });
});

// ---------------------------------------------------------------------------
// #1349: wait's in-loop landmark identity verification (replay-only,
// threaded as `target.recordedLandmark`). Polling semantics are preserved —
// a same-selector impostor never aborts the wait; only the deadline turns
// rejected candidates into the fail-closed landmark refusal.
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
      assert.equal(thrown.details?.reason, undefined);
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

// ---------------------------------------------------------------------------
// Wait polls ride out captures that judged the screen unreadable (the
// mid-transition Android helper content verdicts) instead of aborting the
// wait — the live-validated destination-guard gap from #1349's PR review.
// ---------------------------------------------------------------------------

function unreadableCaptureError() {
  return new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper returned insufficient foreground app content',
    {
      androidSnapshotHelperFailureReason: 'content-poor-app-window',
      retriable: true,
    },
  );
}

function waitDeviceWithCaptures(captures: Array<() => ReturnType<typeof landmarkScreen>>) {
  let call = 0;
  return createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => {
        const produce = captures[Math.min(call, captures.length - 1)]!;
        call += 1;
        return { snapshot: produce() };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
}

test('runtime wait rides out an unreadable mid-transition capture and succeeds on the next poll', async () => {
  const device = waitDeviceWithCaptures([
    () => {
      throw unreadableCaptureError();
    },
    () => landmarkScreen('Detail Screen'),
  ]);

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 5000 },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') throw new Error('unreachable');
  assert.equal(result.waitedMs >= 300, true);
});

test('runtime wait rethrows the capture verdict when the screen never became readable', async () => {
  const device = waitDeviceWithCaptures([
    () => {
      throw unreadableCaptureError();
    },
  ]);

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 1000 },
    }),
    /insufficient foreground app content/,
  );
});

test('runtime wait keeps the plain timeout when readable polls simply never matched', async () => {
  const empty = () => makeSnapshotState([{ index: 0, depth: 0, type: 'Other', label: 'Loading' }]);
  const device = waitDeviceWithCaptures([
    empty,
    () => {
      throw unreadableCaptureError();
    },
  ]);

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 1000 },
    }),
    /wait timed out for selector/,
  );
});

function failingWaitDevice(produceError: () => Error): {
  device: ReturnType<typeof createAgentDevice>;
  attempts: () => number;
} {
  let attempts = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => {
        attempts += 1;
        throw produceError();
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
  return { device, attempts: () => attempts };
}

test('runtime wait still fails immediately on a non-content capture failure', async () => {
  const { device, attempts } = failingWaitDevice(
    () => new AppError('COMMAND_FAILED', 'adb device offline'),
  );

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 5000 },
    }),
    /adb device offline/,
  );
  // Fail-FAST, not fail-at-deadline: a single capture attempt, no polling.
  assert.equal(attempts(), 1);
});

test('runtime wait fails immediately on a helper MECHANISM failure even though it carries androidSnapshotHelperFailureReason', async () => {
  // The realistic wrapper shape: androidSnapshotHelperCaptureError /
  // androidSnapshotHelperUnavailableError stamp the SAME details key as the
  // content verdicts, but with free-form mechanism reasons. Those must not be
  // polled until the wait deadline — the broad any-string classifier would
  // ride this to the deadline and rethrow the same error, so the attempt
  // count (not the eventual message) is what makes this regression bite.
  const { device, attempts } = failingWaitDevice(
    () =>
      new AppError(
        'COMMAND_FAILED',
        'Android snapshot helper failed: instrumentation run timed out after 120000ms',
        {
          androidSnapshotHelperFailureReason: 'instrumentation run timed out after 120000ms',
          hint: 'The device may be busy; retry once it settles.',
        },
      ),
  );

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 5000 },
    }),
    /instrumentation run timed out/,
  );
  assert.equal(attempts(), 1);
});
