import { beforeEach, expect, test, vi } from 'vitest';
import type { SnapshotBackend } from '@agent-device/kernel/snapshot';
import type { CommandFlags } from '@agent-device/contracts/command';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { activateCompleteRefFrame } from '../ref-frame.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { buildSnapshotState } from '../../core/snapshot-state.ts';

// #1638 `--settle` on the GENERIC daemon route (scroll/back): the settled diff,
// its refs, and the ref-frame/generation dance are the same contract the touch
// commands get — but the baseline is the session's stored pre-action tree, not
// a resolution, and the observation must run after the deferred-outcome
// markers. Quiet windows are tuned down so no test waits real time.

vi.mock('../handlers/interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/interaction-snapshot.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(async () => ({
      nodes: [],
      createdAt: 0,
      backend: 'xctest' as const,
    })),
  };
});

import { captureSnapshotForSession } from '../handlers/interaction-snapshot.ts';
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
  const snapshotData = (await mockDispatch('snapshot')) as {
    nodes?: never[];
    backend?: SnapshotBackend;
  };
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
      return { nodes, backend: 'xctest' };
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

function seedSession(sessionName: string, sessionStore: SessionStore): SessionState {
  const session = makeIosSession(sessionName);
  setSessionSnapshot(session, buildSnapshotState({ nodes: BEFORE_NODES, backend: 'xctest' }, {}));
  activateCompleteRefFrame(session);
  sessionStore.set(sessionName, session);
  return session;
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
    (session, flags, sessionStore, _contextFromFlags, options) =>
      emulateCaptureSnapshotForSession(session, flags, sessionStore, options),
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
  expect(stored.refFrameState).toBe('active');
  expect(settle.refsGeneration).toBe(stored.snapshotGeneration);
  expect(stored.snapshot?.nodes.some((node) => node.label === 'Load more')).toBe(true);
});

test('back --settle answers with the settled diff alongside the command result', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-back';
  const session = seedSession(sessionName, sessionStore);
  mockDispatch.mockImplementation(async (command) => {
    if (command === 'snapshot') return { nodes: AFTER_NODES, backend: 'xctest' };
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
  expect((sessionStore.get(sessionName) as SessionState).refFrameState).toBe('expired');
});

test('a settle observation that cannot build a runtime degrades instead of failing the action', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-evicted';
  // The session the router handed us is no longer in the store — evicted
  // between dispatch and observation. Building the settle runtime throws
  // SESSION_NOT_FOUND, and the observation is best-effort: the scroll already
  // happened, so the response keeps its result and simply carries no settle.
  const session = makeIosSession(sessionName);
  setSessionSnapshot(session, buildSnapshotState({ nodes: BEFORE_NODES, backend: 'xctest' }, {}));
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
