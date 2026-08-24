import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { activateCompleteRefFrame } from '../../ref-frame.ts';
import { setSessionSnapshot, STALE_SNAPSHOT_REFS_WARNING } from '../../session-snapshot.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  findResolvedTarget,
  makeFindPreresolvedTree,
  makeSession,
  makeStaleRefSession,
  makeTwoButtonNodes,
  readPressPoint,
  runFindInternalClick,
  runInteraction,
} from './interaction-touch-fixtures.ts';

// Whether a targeted touch may act, and on what: click-option and positional
// validation, and the ADR 0014 @ref rules (staleness, pins, frame expiry,
// locator provenance) that admit or reject before any device op.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../../platforms/android/input-actions.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/input-actions.ts')>();
  return { ...actual, getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })) };
});

vi.mock('../../../platforms/android/window-state.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/window-state.ts')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import {
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
} from '../../../platforms/android/window-state.ts';
import { getAndroidScreenSize } from '../../../platforms/android/input-actions.ts';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogObservation = vi.mocked(getAndroidBlockingDialogObservation);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  resetGetRuntimeFixture();
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogObservation.mockReset();
  mockGetAndroidBlockingDialogObservation.mockResolvedValue({ status: 'clear' });
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  mockCaptureSnapshotForSession.mockReset();
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

test('click --button middle on macOS fails with an explicit unsupported-operation error', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'macos-desktop',
    name: 'My Mac',
    kind: 'device',
    booted: true,
  };
  sessionStore.set(sessionName, session);

  mockTapPoint.mockRejectedValue(
    new Error('dispatch should not be called for unsupported middle click'),
  );

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['100', '200'],
      flags: { clickButton: 'middle' },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/middle is not supported/i);
  }
});

test('press coordinates does not treat extra trailing args as selector', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, makeSession(sessionName));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['100', '200', 'extra'],
      flags: { count: 2 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 100, y: 200 } }));
  expect(sessionStore.get(sessionName)?.actions.length).toBe(1);
});

test('#1654: the resolved-target payload fails closed when its ref provenance disagrees', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'find-preresolved-mismatched-ref';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));
  const preresolved = makeFindPreresolvedTree();

  const response = await runFindInternalClick(sessionStore, sessionName, {
    findResolvedTarget: findResolvedTarget(preresolved, '@e9'),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toContain('provenance does not match');
  }
  expect(readPressPoint(mockTapPoint)).toBeUndefined();
});

test('press selector then press @ref rejects refs that outlived the stored snapshot before dispatch', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-ref-warns';
  const session = makeStaleRefSession(sessionName);
  sessionStore.set(sessionName, session);
  mockCaptureSnapshotForSession.mockResolvedValue({
    nodes: makeTwoButtonNodes(),
    backend: 'xctest',
    producer: 'apple-runner',
  });

  // Selector press: its resolution capture replaces the stored snapshot
  // without handing the new refs back to the client.
  const selectorPress = await runInteraction(sessionStore, sessionName, 'press', [
    'label=Continue',
  ]);
  if (!selectorPress?.ok) {
    throw new Error(`selector press failed: ${JSON.stringify(selectorPress)}`);
  }
  expect(selectorPress.data?.warning).toBeUndefined();

  // ADR 0014: the selector press crossed the side-effect seam and expired the
  // frame, so the ref that outlived it is rejected before dispatch.
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
  const touchCallsBeforeStaleRef = mockTapPoint.mock.calls.length;
  const refPress = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);
  expect(refPress?.ok).toBe(false);
  if (refPress && !refPress.ok) {
    expect(refPress.error.code).toBe('COMMAND_FAILED');
    expect(refPress.error.message).toMatch(/expired ref frame/);
    expect(refPress.error.details?.reason).toBe('ref_frame_expired');
    expect(refPress.error.details?.hint).toBe(STALE_SNAPSHOT_REFS_WARNING);
  }
  expect(mockTapPoint).toHaveBeenCalledTimes(touchCallsBeforeStaleRef);
});

test('a ref press crosses the ADR 0014 side-effect seam and expires the ref frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'seam-expiry';
  const session = makeStaleRefSession(sessionName);
  sessionStore.set(sessionName, session);
  mockCaptureSnapshotForSession.mockResolvedValue({
    nodes: makeTwoButtonNodes(),
    backend: 'xctest',
    producer: 'apple-runner',
  });

  // A freshly issued complete frame is active.
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('active');

  const press = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);
  expect(press?.ok).toBe(true);
  // The transition is wired at the leaf seam.
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
});

test('ADR 0014 evidence #1: a second ref mutation rejects (bare and pinned) until a fresh observation re-authorizes', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'seam-sequence';
  const session = makeStaleRefSession(sessionName);
  session.snapshotGeneration = 500;
  // A complete snapshot issued the frame at generation 500.
  activateCompleteRefFrame(session);
  sessionStore.set(sessionName, session);
  mockCaptureSnapshotForSession.mockResolvedValue({
    nodes: makeTwoButtonNodes(),
    backend: 'xctest',
    producer: 'apple-runner',
  });

  // `snapshot -> press @e1`: admitted; crosses the seam and expires the frame.
  const first = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);
  expect(first?.ok).toBe(true);
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');

  // `-> press @e2`: the unobserved second mutation rejects (bare).
  const bare = await runInteraction(sessionStore, sessionName, 'press', ['@e2']);
  expect(bare?.ok).toBe(false);
  if (bare && !bare.ok) expect(bare.error.details?.reason).toBe('ref_frame_expired');

  // A pin at the same epoch also rejects — expiry is evaluated before the pin.
  const pinned = await runInteraction(sessionStore, sessionName, 'press', ['@e2~s500']);
  expect(pinned?.ok).toBe(false);
  if (pinned && !pinned.ok) expect(pinned.error.details?.reason).toBe('ref_frame_expired');

  // `-> snapshot -> press @e2`: a fresh complete frame re-authorizes.
  activateCompleteRefFrame(sessionStore.get(sessionName)!);
  const reobserved = await runInteraction(sessionStore, sessionName, 'press', ['@e2']);
  expect(reobserved?.ok).toBe(true);
});

test('press @ref directly after refs were issued does not warn', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'fresh-ref-no-warning';
  const session = makeStaleRefSession(sessionName);
  sessionStore.set(sessionName, session);

  const response = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toBeUndefined();
  }
});

test('re-issuing a complete frame lets press @ref succeed again without warning', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'reissued-refs-no-warning';
  const session = makeStaleRefSession(sessionName);
  sessionStore.set(sessionName, session);
  mockCaptureSnapshotForSession.mockResolvedValue({
    nodes: makeTwoButtonNodes(),
    backend: 'xctest',
    producer: 'apple-runner',
  });

  const selectorPress = await runInteraction(sessionStore, sessionName, 'press', [
    'label=Continue',
  ]);
  expect(selectorPress?.ok).toBe(true);
  // The selector press expired the frame (ADR 0014 seam).
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');

  // Simulate the snapshot command re-issuing the complete ref namespace: it
  // re-activates a complete frame (through buildNextSnapshotSession; covered in
  // snapshot-handler tests). Without it the frame would stay expired.
  const stored = sessionStore.get(sessionName)!;
  activateCompleteRefFrame(stored);
  sessionStore.set(sessionName, stored);

  const refPress = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);
  expect(refPress?.ok).toBe(true);
  if (refPress?.ok) {
    expect(refPress.data?.warning).toBeUndefined();
  }
});

// --- Versioned @ref pins (#1076 follow-up) ---

test('press with a pinned ref matching the current frame epoch is clean', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'pinned-current-clean';
  const session = makeStaleRefSession(sessionName);
  session.snapshotGeneration = 5;
  sessionStore.set(sessionName, session);

  const response = await runInteraction(sessionStore, sessionName, 'press', ['@e1~s5']);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toBeUndefined();
  }
});

test('press with a pinned ref from an older generation rejects with the precise hint', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'pinned-stale-precise';
  const session = makeStaleRefSession(sessionName);
  session.snapshotGeneration = 15;
  sessionStore.set(sessionName, session);
  mockTapPoint.mockRejectedValue(new Error('touch should not be called for a stale iOS ref'));

  const response = await runInteraction(sessionStore, sessionName, 'press', ['@e1~s12']);
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.details?.hint).toBe(
      "Ref @e1 was minted from snapshot s12 but the session's ref frame is now s15 — re-run snapshot -i.",
    );
  }
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test('ADR 0014 evidence #6: a read-only capture does not invalidate a mutation ref', async () => {
  // An internal read-only capture advances the operational observation (and the
  // generation counter) but does NOT expire the frame, so a plain ref from the
  // still-active frame is admitted and dispatches — the old coarse-marker
  // mutation block was the ADR's false positive.
  const sessionStore = makeSessionStore();
  const sessionName = 'read-capture-preserves';
  const session = makeStaleRefSession(sessionName);
  // Simulate a read-only capture (e.g. --verify evidence) replacing the
  // observation: it bumps the generation but leaves the frame active.
  setSessionSnapshot(session, {
    nodes: attachRefs(makeTwoButtonNodes() as never),
    createdAt: Date.now(),
    backend: 'xctest',
  });
  expect(session.refFrameState).toBe('active');
  sessionStore.set(sessionName, session);
  mockTapPoint.mockResolvedValue({ pressed: true });

  const response = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);
  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalled();
  // Crossing the seam expired the frame, so a SECOND plain ref is now rejected.
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
  const second = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);
  expect(second?.ok).toBe(false);
  if (second && !second.ok) {
    expect(second.error.details?.reason).toBe('ref_frame_expired');
  }
});

test('a malformed generation suffix is INVALID_ARGS with the ref grammar hint', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'pinned-malformed';
  const session = makeStaleRefSession(sessionName);
  sessionStore.set(sessionName, session);

  for (const [command, positionals] of [
    ['press', ['@e1~x3']],
    ['fill', ['@e1~s', 'text']],
    ['get', ['text', '@e1~3']],
  ] as const) {
    const response = await runInteraction(sessionStore, sessionName, command, [...positionals]);
    expect(response?.ok).toBe(false);
    if (response && !response.ok) {
      expect(response.error.code).toBe('INVALID_ARGS');
      expect(response.error.message).toContain('malformed generation suffix');
      expect(String(response.error.details?.hint)).toContain('@e12~s3');
    }
  }
});

test('after a session reopen, a pin from the previous lifetime rejects (reseeded generations)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'reopened-pin-warns';
  // Previous lifetime: a seeded generation minted the client's pin.
  const previous = makeStaleRefSession(sessionName);
  setSessionSnapshot(previous, { ...previous.snapshot! });
  const oldGeneration = previous.snapshotGeneration!;

  // Reopen: fresh session object, same name — the counter reseeds, so the
  // old pin cannot silently read as current even though both lifetimes are
  // one replacement deep (a per-lifetime count from 1 would collide here).
  const reopened = makeStaleRefSession(sessionName);
  setSessionSnapshot(reopened, { ...reopened.snapshot! });
  sessionStore.set(sessionName, reopened);
  // Probabilistic (~1/900000 collision) — accepted residual risk.
  expect(reopened.snapshotGeneration).not.toBe(oldGeneration);
  mockTapPoint.mockRejectedValue(new Error('touch should not be called for a stale iOS ref'));

  const response = await runInteraction(sessionStore, sessionName, 'press', [
    `@e1~s${oldGeneration}`,
  ]);
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(String(response.error.details?.hint)).toContain(
      `minted from snapshot s${oldGeneration}`,
    );
  }
  expect(mockTapPoint).not.toHaveBeenCalled();
});
