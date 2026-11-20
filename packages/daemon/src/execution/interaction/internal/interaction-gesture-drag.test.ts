import { beforeEach, expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { attachRefs } from '@agent-device/kernel/snapshot';
import {
  makeIosSession,
  authoringPublication,
} from '../../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import {
  createTouchCommandSurface,
  touchCreateCommandSurface,
} from '../../../__tests__/support/touch-command-surface-fake.ts';
import { activateCompleteRefFrame, refFrameScope, refFrameState } from '../../../core/ref-frame.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import { readPressPoint } from './__tests__/interaction-touch-fixtures.ts';

import { handleInteractionCommands } from '../index.ts';
import { gestureRuntimeBindingsFixture } from './__tests__/gesture-runtime-bindings.fixtures.ts';

const contextFromFlags = () => ({});
const captureSnapshotForSession = async ({
  session,
}: import('../../../core/session-state.ts').SessionRef) => session.snapshot!;
let gestures = gestureRuntimeBindingsFixture();

beforeEach(() => {
  gestures = gestureRuntimeBindingsFixture();
  resetGetRuntimeFixture();
});

function makeDragSession(sessionName: string) {
  const session = makeIosSession(sessionName, {
    appBundleId: 'com.example.drag-fixture',
    scriptPublication: authoringPublication('armed'),
  });
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'View',
        identifier: 'drag-source',
        label: 'Drag source',
        rect: { x: 20, y: 100, width: 120, height: 60 },
        hittable: true,
      },
      {
        index: 2,
        parentIndex: 0,
        type: 'View',
        identifier: 'drop-target',
        label: 'Drop target',
        rect: { x: 220, y: 400, width: 140, height: 80 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.snapshotGeneration = 42;
  activateCompleteRefFrame(session);
  return session;
}

async function runDrag(sessionStore: ReturnType<typeof makeSessionStore>, sessionName: string) {
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'gesture',
      positionals: [],
      flags: {},
      input: {
        kind: 'drag',
        source: '@e2~s42',
        destination: '@e3~s42',
        sourceHoldMs: 700,
        moveMs: 600,
        destinationHoldMs: 200,
      },
    },
    sessionName,
    sessionStore,
    captureSnapshotForSession,
    contextFromFlags,
    inspectFacts: gestures.inspectFacts,
    bindDevice: gestures.bindDevice,
  });
}

test('recorded ref drag dispatches once and stores portable selectors with both endpoint identities', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recorded-drag';
  const session = makeDragSession(sessionName);
  sessionStore.publish(sessionName, session);

  const response = await runDrag(sessionStore, sessionName);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).toMatchObject({
      kind: 'drag',
      durationMs: 1_500,
      from: { x: 80, y: 130 },
      to: { x: 290, y: 440 },
      targets: {
        source: {
          selectorChain: expect.arrayContaining(['id="drag-source"']),
          resolution: { source: 'ref', phase: 'pre-action', kind: 'exact' },
        },
        destination: {
          selectorChain: expect.arrayContaining(['id="drop-target"']),
          resolution: { source: 'ref', phase: 'pre-action', kind: 'exact' },
        },
      },
    });
    expect(response.data).not.toHaveProperty('recording');
    expect(response.data).not.toHaveProperty('selectorChain');
    expect(response.data).not.toHaveProperty('targetEvidence');
  }
  // ADR 0019 §9 regression guard: a drag resolves two targets and still takes exactly one
  // inspection and one bind — the #1944 P1 shape.
  expect(gestures.performTargetAuthoredDrag).toHaveBeenCalledTimes(1);
  expect(gestures.inspectFacts).toHaveBeenCalledTimes(1);
  expect(gestures.bindDevice).toHaveBeenCalledTimes(1);
  expect(refFrameState(session)).toBe('expired');

  const recorded = session.actions[0];
  expect(recorded?.positionals?.[0]).toBe('drag');
  expect(recorded?.positionals?.[1]).toBe('id="drag-source"');
  expect(recorded?.positionals?.[2]).toBe('id="drop-target"');
  expect(recorded?.positionals?.slice(3)).toEqual(['700', '600', '200']);
  expect(recorded?.result).toMatchObject({
    selectorChain: expect.arrayContaining(['id="drag-source"']),
  });
  expect(recorded?.targetEvidence).toBeUndefined();
  expect(recorded?.targetEvidences).toMatchObject({
    source: { id: 'drag-source', label: 'Drag source', verification: 'verified' },
    destination: { id: 'drop-target', label: 'Drop target', verification: 'verified' },
  });
});

test('a second ref drag is rejected before dispatch after the first drag expires the frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-drag';
  sessionStore.publish(sessionName, makeDragSession(sessionName));

  expect((await runDrag(sessionStore, sessionName))?.ok).toBe(true);
  const response = await runDrag(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.details).toMatchObject({
      reason: 'ref_frame_expired',
      ref: '@e2',
      currentGeneration: 42,
    });
  }
  expect(gestures.performTargetAuthoredDrag).toHaveBeenCalledTimes(1);
});

// #2870 review, the gesture route's own coverage: a drag whose target selector
// refused with candidate lines must ITSELF issue the refs it prints — the same
// contract the touch routes give. Without the seam, the refusal printed bare
// candidate refs minted from the capture the drag itself consumed, and a
// caller that pasted one was refused (superseded / needs-complete) the moment
// it retried. The acceptance here is the copy: the pinned ref the refusal
// suggests is admitted on the frame the refusal issued and taps the listed node.
test('an ambiguous drag issues its printed candidates so press acts on the listed node', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'drag-ambiguity-issuance';
  const session = makeAmbiguousDragSession(sessionName);
  sessionStore.publish(sessionName, session);

  const dragAmbiguitySurface = createTouchCommandSurface({
    matchSelector: (_nodes, selector) => {
      throw new AppError('AMBIGUOUS_MATCH', `Selector matched 2 elements: ${selector}`, {
        matches: 2,
        candidates: ['@e2 [view] "Drag source"', '@e4 [view] "Drag source"'],
        dispatched: 'no',
      });
    },
  });
  const response = await handleInteractionCommands({
    createCommandSurface: dragAmbiguitySurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'gesture',
      positionals: [],
      flags: {},
      input: {
        kind: 'drag',
        source: 'label="Drag source"',
        destination: 'label="Drop target"',
        sourceHoldMs: 700,
        moveMs: 600,
        destinationHoldMs: 200,
      },
    },
    sessionName,
    sessionStore,
    captureSnapshotForSession,
    contextFromFlags,
    inspectFacts: gestures.inspectFacts,
    bindDevice: gestures.bindDevice,
  });

  expect(response?.ok).toBe(false);
  if (!response || response.ok) throw new Error('expected the acting ambiguity refusal');
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  // The refusal is ref-issuing on the same wire shape the touch routes give:
  // bare candidate lines, the epoch additive once as `refsGeneration`, and the
  // frame scope holding exactly the printed bodies. The surfaces pair the two
  // into the pinned, paste-ready ref.
  const refsGeneration = response.error.details?.refsGeneration as number;
  expect(refsGeneration).toBe(session.snapshotGeneration);
  expect(response.error.details?.candidates).toEqual([
    '@e2 [view] "Drag source"',
    '@e4 [view] "Drag source"',
  ]);
  expect(refFrameState(session)).toBe('active');
  expect([...refFrameScope(session)].sort()).toEqual(['e2', 'e4']);

  // Copy the first printed candidate, pinned as the response's generation
  // directs, and press it: admitted on the issued frame, it taps the LISTED
  // node — e2 at (20,100), center (80,130) — before any device dispatch the
  // refusal could have raced.
  const printedLines = response.error.details?.candidates as string[] | undefined;
  const firstPrinted = printedLines?.[0];
  if (!firstPrinted) throw new Error('expected the refusal to print candidates');
  const printed = `${firstPrinted.replace(/\s.*$/, '')}~s${refsGeneration}`;
  expect(printed).toBe(`@e2~s${refsGeneration}`);
  const press = await handleInteractionCommands({
    createCommandSurface: createTouchCommandSurface({}),
    req: { token: 't', session: sessionName, command: 'press', positionals: [printed], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  expect(press?.ok).toBe(true);
  expect(readPressPoint(mockTapPoint)).toEqual(['80', '130']);
});

/**
 * The ambiguous two-source tree: two same-label drag sources in distinct
 * branches (e2 at (20,100), e4 at (20,300)), so the refusal names both and the
 * retried candidate ref provably selects one of them. Raw nodes: the capture
 * path attaches refs itself (e1 root, e2/e4 the sources, e3 the target).
 */
function makeAmbiguousDragSession(sessionName: string) {
  const session = makeIosSession(sessionName, {
    appBundleId: 'com.example.drag-fixture',
    scriptPublication: authoringPublication('armed'),
  });
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'View',
        label: 'Drag source',
        rect: { x: 20, y: 100, width: 120, height: 60 },
        hittable: true,
      },
      {
        index: 2,
        parentIndex: 0,
        type: 'View',
        identifier: 'drop-target',
        label: 'Drop target',
        rect: { x: 220, y: 400, width: 140, height: 80 },
        hittable: true,
      },
      {
        index: 3,
        parentIndex: 0,
        type: 'View',
        label: 'Drag source',
        rect: { x: 20, y: 300, width: 120, height: 60 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.snapshotGeneration = 42;
  activateCompleteRefFrame(session);
  return session;
}
