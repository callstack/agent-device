import { beforeEach, expect, test, vi } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  IOS_SYSTEM_SURFACE_DISCLOSURE,
  iosSystemSurfaceTransitionDisclosure,
  type IosSystemSurfaceProvenance,
} from '@agent-device/contracts/ios-system-surface';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { activateCompleteRefFrame, refFrameState } from '../ref-frame.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import type { SessionState } from '../session-state.ts';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';

// #1638 `--settle` on the GENERIC daemon route (scroll/back): the settled diff,
// its refs, and the ref-frame/generation dance are the same contract the touch
// commands get — but the baseline is the session's stored pre-action tree, not
// a resolution, and the observation must run after the deferred-outcome
// markers. Quiet windows are tuned down so no test waits real time.

vi.mock('../interaction/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction/index.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(async () => ({
      nodes: [],
      createdAt: 0,
      backend: 'xctest',
      producer: 'apple-runner' as const,
    })),
  };
});

import { captureSnapshotForSession } from '../interaction/index.ts';
import { dispatchGenericCommand } from '../request-generic-dispatch.ts';

const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotForSession);

const BEFORE_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    rect: { x: 10, y: 20, width: 120, height: 44 },
    hittable: true,
  },
];

const AFTER_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Load more',
    rect: { x: 10, y: 20, width: 120, height: 44 },
    hittable: true,
  },
];

const SETTLE_FLAGS = { settle: true, settleQuietMs: 25, timeoutMs: 2_000 } satisfies CommandFlags;

type SettlePayload = {
  settled: boolean;
  captures: number;
  quietMs: number;
  timeoutMs: number;
  refsGeneration?: number;
  diff?: {
    summary: { additions: number; removals: number; unchanged: number };
    lines: Array<{ kind: string; text: string; ref?: string }>;
  };
  tail?: Array<{ ref: string; role: string; label?: string }>;
  surfaceChange?: { from: string; to: string; disclosure: string };
  hint?: string;
};

/** Capture observations made from inside the emulated capture, in call order. */
const captureObservations: Array<{ postGestureStabilizationPending: boolean }> = [];

async function emulateCaptureSnapshotForSession(
  session: SessionState,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  options: { interactiveOnly: boolean },
) {
  captureObservations.push({
    postGestureStabilizationPending: session.postGestureStabilization !== undefined,
  });
  const effectiveFlags = { ...(flags ?? {}), snapshotInteractiveOnly: options.interactiveOnly };
  const snapshotData = (await mockDispatch('snapshot')) as Parameters<typeof buildSnapshotState>[0];
  const snapshot = buildSnapshotState(snapshotData ?? {}, effectiveFlags);
  setSessionSnapshot(session, snapshot);
  sessionStore.set(session.name, session);
  return snapshot;
}

function mockCommandDispatch(snapshots: Array<typeof BEFORE_NODES>) {
  let snapshotCalls = 0;
  mockDispatch.mockImplementation(async (command) => {
    if (command === 'snapshot') {
      const nodes = snapshots[Math.min(snapshotCalls, snapshots.length - 1)];
      snapshotCalls += 1;
      return { nodes, backend: 'xctest', producer: 'apple-runner' };
    }
    return {};
  });
}

const contextFromFlags = () => ({}) as never;

/**
 * The bound execution `dispatchGenericCommand` runs. R58 retired the legacy dispatcher this file
 * used to borrow, so the double lives here: these tests are about the settle/stabilization
 * orchestration around a generic leaf, not about which owner performs it.
 */
const platformExecution = vi.fn(
  async (params: { command: string }) => await mockDispatch(params.command),
);

/** Stands in for the device work a bound generic leaf performs, keyed by command name. */
const mockDispatch = vi.fn<(command: string) => Promise<Record<string, unknown>>>(async () => ({}));

/**
 * The session as it stands before the generic command runs. `baseline` is the STORED pre-action
 * tree the settled diff is taken against, and the surface that capture described — which is how a
 * session whose last observation was an in-place system surface (#2438) is set up.
 */
function seedSession(
  sessionName: string,
  sessionStore: SessionStore,
  baseline: GenericSettleTree = { nodes: BEFORE_NODES },
): SessionState {
  const session = makeIosSession(sessionName);
  setSessionSnapshot(session, buildSnapshotState(snapshotPayload(baseline), {}));
  activateCompleteRefFrame(session);
  sessionStore.set(sessionName, session);
  return session;
}

/** A tree plus the surface a capture of it describes: app content, or an in-place system surface. */
type GenericSettleTree = {
  nodes: RawSnapshotNode[];
  systemSurface?: IosSystemSurfaceProvenance;
};

function snapshotPayload(tree: GenericSettleTree) {
  return {
    nodes: tree.nodes,
    backend: 'xctest' as const,
    producer: 'apple-runner' as const,
    ...(tree.systemSurface ? { systemSurface: tree.systemSurface } : {}),
  };
}

/**
 * Every settle capture reads `tree`; any other command answers `result`. Unlike
 * {@link mockCommandDispatch} the captured tree carries its surface provenance, so the settled
 * capture can describe a surface other than the one the stored baseline described.
 */
function mockSurfaceDispatch(tree: GenericSettleTree, result: Record<string, unknown> = {}) {
  mockDispatch.mockImplementation(async (command) =>
    command === 'snapshot' ? snapshotPayload(tree) : result,
  );
}

async function dispatchGeneric(params: {
  sessionName: string;
  sessionStore: SessionStore;
  session: SessionState;
  command: string;
  positionals?: string[];
  flags?: CommandFlags;
}): Promise<DaemonResponse> {
  const req: DaemonRequest = {
    token: 't',
    session: params.sessionName,
    command: params.command,
    positionals: params.positionals ?? [],
    ...(params.flags ? { flags: params.flags } : {}),
  };
  return await dispatchGenericCommand({
    req,
    session: params.session,
    sessionName: params.sessionName,
    logPath: '',
    sessionStore: params.sessionStore,
    contextFromFlags,
    executePlatformCommand: platformExecution,
  });
}

function expectOkData(response: DaemonResponse): Record<string, unknown> {
  expect(response.ok).toBe(true);
  if (response.ok !== true) throw new Error('expected an ok daemon response');
  return (response.data ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  captureObservations.length = 0;
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(
    (...args: Parameters<typeof captureSnapshotForSession>) => {
      const [session, flags, sessionStore, _contextFromFlags, options] = args;
      return emulateCaptureSnapshotForSession(session, flags, sessionStore, options);
    },
  );
});

test('scroll --settle answers with the settled diff against the stored pre-action tree', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-scroll';
  const session = seedSession(sessionName, sessionStore);
  // Every settle capture sees the post-scroll tree; the diff baseline is the
  // tree already stored on the session, not a capture taken here.
  mockCommandDispatch([AFTER_NODES]);

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  const settle = expectOkData(response).settle as SettlePayload;
  expect(settle.settled).toBe(true);
  expect(settle.quietMs).toBe(25);
  expect(settle.timeoutMs).toBe(2_000);
  expect(settle.diff?.summary).toEqual({ additions: 1, removals: 1, unchanged: 1 });
  expect(settle.diff?.lines).toContainEqual({
    kind: 'added',
    text: expect.stringContaining('Load more'),
    ref: 'e2',
  });
  // `SettleDiffLine`: removed lines never carry a ref — their refs would name
  // nodes of the REPLACED tree, and ref bodies are index-derived, so `@e2` on a
  // removed line is a different element in the settled tree that took its slot.
  // Enforced in snapshot-diff (removed lines are built without one); asserted
  // here because this route is the one that diffs against the STORED session
  // snapshot, whose nodes all carry refs, so it is where a regression would
  // first publish one.
  const removed = settle.diff?.lines.find((line) => line.kind === 'removed');
  expect(removed?.text).toContain('Continue');
  expect(removed?.ref).toBeUndefined();

  // The settled tree became the stored snapshot, and its refs were published:
  // a partial frame is active at the generation the payload reports.
  const stored = sessionStore.get(sessionName) as SessionState;
  expect(refFrameState(stored)).toBe('active');
  expect(settle.refsGeneration).toBe(stored.snapshotGeneration);
  expect(stored.snapshot?.nodes.some((node) => node.label === 'Load more')).toBe(true);
});

test('back --settle answers with the settled diff alongside the command result', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-back';
  const session = seedSession(sessionName, sessionStore);
  mockDispatch.mockImplementation(async (command) => {
    if (command === 'snapshot')
      return { nodes: AFTER_NODES, backend: 'xctest', producer: 'apple-runner' };
    return { action: 'back', mode: 'in-app', message: 'Back' };
  });

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'back',
    flags: { ...SETTLE_FLAGS },
  });

  const data = expectOkData(response);
  // The observation rides ALONGSIDE the command's own closed result shape.
  expect(data.action).toBe('back');
  expect(data.message).toBe('Back');
  expect((data.settle as SettlePayload).diff?.summary).toEqual({
    additions: 1,
    removals: 1,
    unchanged: 1,
  });
});

// #2438 cross-surface settle on the GENERIC route: iOS serves a web sign-in sheet
// (com.apple.SafariViewService) IN PLACE over a still-foreground app, so a settled capture of the
// sheet and the session's stored pre-action tree of the app describe DIFFERENT surfaces. The diff
// above would then be a whole-surface replacement presented as change within one surface — and
// since the daemon treats `diff` presence as "this response issues refs", it would hand the caller
// refs for that claim. This route plumbs the baseline's surface identity through the
// `SurfaceScopedNodes` it hands the settle engine; the element-targeted route guarantees the same contract in
// `src/commands/interaction/runtime/post-action-surface.test.ts`, and these tests assert it for
// scroll/back so the two routes cannot drift.
//
// Both directions are covered because each falsifies a DIFFERENT half of that plumbing, and
// neither substitutes for the other: drop the baseline's surface identity here and only the
// sheet-to-app tests fail (an app baseline has no surface id to lose); drop the settled capture's
// surface identity and only the app-to-sheet tests fail.
const WEB_SIGN_IN_SHEET: IosSystemSurfaceProvenance = {
  bundleId: 'com.apple.SafariViewService',
  kind: 'web-auth',
};

/** Five nodes, so a settled sheet clears the tiny-tree readiness hint and the hint under test is
 * the cross-surface one. No Application root: the sheet is hosted out of the app's process. */
const WEB_SIGN_IN_SHEET_NODES = [
  'Sign in with Example',
  'Email',
  'Password',
  'Continue',
  'Cancel',
].map((label, index) => ({
  index,
  type: 'Button',
  label,
  rect: { x: 10, y: 120 + index * 50, width: 200, height: 44 },
  hittable: true,
}));

/** The app content that returns once the sheet completes and dismisses itself, also past the
 * tiny-tree count so the return direction asserts the same hint contract. */
const APP_CONTENT_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  ...['Load more', 'Profile', 'Settings', 'Sign out'].map((label, offset) => ({
    index: offset + 1,
    parentIndex: 0,
    type: 'Button',
    label,
    rect: { x: 10, y: 20 + offset * 50, width: 120, height: 44 },
    hittable: true,
  })),
];

/**
 * The cross-surface contract a settle route owes, asserted as one unit so `scroll` and `back`
 * cannot drift from each other or from the targeted route: no diff is attached across the
 * boundary — therefore no tail and no issued refs — the transition is disclosed, and the settle
 * observation still reports its own verdict alongside that disclosure rather than instead of it.
 */
function expectCrossSurfaceSettle(
  settle: SettlePayload,
  change: { from: string; to: string; disclosure: string },
): void {
  expect(settle.surfaceChange).toEqual(change);
  expect(settle.diff).toBeUndefined();
  expect(settle.tail).toBeUndefined();
  // `refsGeneration` is folded in only when the settled diff published refs (ADR 0014); a refused
  // diff publishes none, so the payload must not name a generation either.
  expect(settle.refsGeneration).toBeUndefined();
  expect(settle.hint).toContain('different surfaces');
  expect(settle.hint).toMatch(/take a snapshot/i);
  expect(settle.settled).toBe(true);
  expect(settle.captures).toBeGreaterThanOrEqual(2);
  expect(settle.quietMs).toBe(25);
  expect(settle.timeoutMs).toBe(2_000);
}

/** No refs were published, so the frame the mutating leaf expired stays expired (ADR 0014). */
function expectNoPublishedRefFrame(sessionStore: SessionStore, sessionName: string): SessionState {
  const stored = sessionStore.get(sessionName) as SessionState;
  expect(refFrameState(stored)).toBe('expired');
  return stored;
}

test('scroll --settle attaches no diff across an app-to-sheet surface change and discloses it', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-scroll-to-sheet';
  const session = seedSession(sessionName, sessionStore);
  // The stored pre-action tree is app content; every settle capture reads the sheet now presented
  // over that still-foreground app.
  mockSurfaceDispatch({ nodes: WEB_SIGN_IN_SHEET_NODES, systemSurface: WEB_SIGN_IN_SHEET });

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  expectCrossSurfaceSettle(expectOkData(response).settle as SettlePayload, {
    from: 'app',
    to: WEB_SIGN_IN_SHEET.bundleId,
    disclosure: IOS_SYSTEM_SURFACE_DISCLOSURE,
  });
  // Disclosed, not hidden: the settled sheet still becomes the stored observation a follow-up
  // snapshot reads — and the surface identity the NEXT command's baseline is built from.
  const stored = expectNoPublishedRefFrame(sessionStore, sessionName);
  expect(stored.snapshot?.iosSystemSurfaceBundleId).toBe(WEB_SIGN_IN_SHEET.bundleId);
});

test('scroll --settle attaches no diff across a sheet-to-app surface change and discloses it', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-scroll-from-sheet';
  // The baseline is the sheet this scroll acts on; the settled tree is the app content that
  // returns once the sheet completes and dismisses itself.
  const session = seedSession(sessionName, sessionStore, {
    nodes: WEB_SIGN_IN_SHEET_NODES,
    systemSurface: WEB_SIGN_IN_SHEET,
  });
  mockSurfaceDispatch({ nodes: APP_CONTENT_NODES });

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  const settle = expectOkData(response).settle as SettlePayload;
  expectCrossSurfaceSettle(settle, {
    from: WEB_SIGN_IN_SHEET.bundleId,
    to: 'app',
    // The sheet is gone, so the standing "is presented over the app" sentence cannot be the one
    // used — the transition disclosure has to say it left.
    disclosure: iosSystemSurfaceTransitionDisclosure(undefined),
  });
  expect(settle.surfaceChange?.disclosure).not.toBe(IOS_SYSTEM_SURFACE_DISCLOSURE);
  expect(settle.surfaceChange?.disclosure).toMatch(/sign-in sheet/);
  const stored = expectNoPublishedRefFrame(sessionStore, sessionName);
  expect(stored.snapshot?.iosSystemSurfaceBundleId).toBeUndefined();
});

test('back --settle attaches no diff across an app-to-sheet surface change and discloses it', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-back-to-sheet';
  const session = seedSession(sessionName, sessionStore);
  mockSurfaceDispatch(
    { nodes: WEB_SIGN_IN_SHEET_NODES, systemSurface: WEB_SIGN_IN_SHEET },
    {
      action: 'back',
      mode: 'in-app',
      message: 'Back',
    },
  );

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'back',
    flags: { ...SETTLE_FLAGS },
  });

  const data = expectOkData(response);
  // The refusal rides ALONGSIDE the command's own closed result shape, same as the diff does.
  expect(data.action).toBe('back');
  expect(data.message).toBe('Back');
  expectCrossSurfaceSettle(data.settle as SettlePayload, {
    from: 'app',
    to: WEB_SIGN_IN_SHEET.bundleId,
    disclosure: IOS_SYSTEM_SURFACE_DISCLOSURE,
  });
  const stored = expectNoPublishedRefFrame(sessionStore, sessionName);
  expect(stored.snapshot?.iosSystemSurfaceBundleId).toBe(WEB_SIGN_IN_SHEET.bundleId);
});

test('back --settle attaches no diff across a sheet-to-app surface change and discloses it', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-back-from-sheet';
  const session = seedSession(sessionName, sessionStore, {
    nodes: WEB_SIGN_IN_SHEET_NODES,
    systemSurface: WEB_SIGN_IN_SHEET,
  });
  mockSurfaceDispatch(
    { nodes: APP_CONTENT_NODES },
    {
      action: 'back',
      mode: 'in-app',
      message: 'Back',
    },
  );

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'back',
    flags: { ...SETTLE_FLAGS },
  });

  const data = expectOkData(response);
  expect(data.action).toBe('back');
  expectCrossSurfaceSettle(data.settle as SettlePayload, {
    from: WEB_SIGN_IN_SHEET.bundleId,
    to: 'app',
    disclosure: iosSystemSurfaceTransitionDisclosure(undefined),
  });
  const stored = expectNoPublishedRefFrame(sessionStore, sessionName);
  expect(stored.snapshot?.iosSystemSurfaceBundleId).toBeUndefined();
});

test('the settle observation runs after the post-gesture stabilization marker', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-order';
  const session = seedSession(sessionName, sessionStore);
  mockCommandDispatch([AFTER_NODES]);

  await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  // #1542 ordering: scroll marks a pending stabilization, and settle's FIRST
  // capture must already see it so the capture folds the stabilization in
  // instead of racing it.
  expect(captureObservations.length).toBeGreaterThan(0);
  expect(captureObservations[0]?.postGestureStabilizationPending).toBe(true);
});

test('scroll without --settle takes no observation captures and issues no refs', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-off';
  const session = seedSession(sessionName, sessionStore);
  mockCommandDispatch([AFTER_NODES]);

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'scroll',
    positionals: ['down'],
  });

  expect(expectOkData(response).settle).toBeUndefined();
  expect(captureObservations).toEqual([]);
  // ADR 0014: the leaf side-effect seam expired the frame and nothing
  // re-published it.
  expect(refFrameState(sessionStore.get(sessionName) as SessionState)).toBe('expired');
});

test('a settle observation that cannot build a runtime degrades instead of failing the action', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-evicted';
  // The session the router handed us is no longer in the store — evicted
  // between dispatch and observation. Building the settle runtime throws
  // SESSION_NOT_FOUND, and the observation is best-effort: the scroll already
  // happened, so the response keeps its result and simply carries no settle.
  const session = makeIosSession(sessionName);
  setSessionSnapshot(
    session,
    buildSnapshotState({ nodes: BEFORE_NODES, backend: 'xctest', producer: 'apple-runner' }, {}),
  );
  activateCompleteRefFrame(session);
  mockCommandDispatch([AFTER_NODES]);

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  const data = expectOkData(response);
  expect(data.settle).toBeUndefined();
  expect(captureObservations).toEqual([]);
});

test('a generic command without the observation trait ignores a stray settle flag', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-traitless';
  const session = seedSession(sessionName, sessionStore);
  mockDispatch.mockResolvedValue({ action: 'home', message: 'Home' });

  // A hand-built daemon request can put settle flags on any command; only the
  // descriptor trait admits them to the observation path. `home` has no trait,
  // so the flag is ignored: no captures, no settle payload, no rejection.
  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'home',
    flags: { settle: true },
  });

  expect(expectOkData(response).settle).toBeUndefined();
  expect(captureObservations).toEqual([]);
});

test('an orphaned --settle-quiet is rejected before the command dispatches', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-orphan';
  const session = seedSession(sessionName, sessionStore);
  mockDispatch.mockRejectedValue(new Error('dispatch must not run for an orphaned settle flag'));

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: { settleQuietMs: 25 },
  });

  expect(response.ok).toBe(false);
  if (response.ok !== false) throw new Error('expected a rejected daemon response');
  expect(response.error?.code).toBe('INVALID_ARGS');
  expect(response.error?.message).toContain('--settle-quiet');
});
