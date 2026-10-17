import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { PresentedSurface, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { IosSystemSurfaceProvenance } from '@agent-device/contracts/ios-system-surface';
import { makeIosSession } from '../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import {
  activateCompleteRefFrame,
  markSessionSnapshotOutdated,
  refFrameState,
} from '../core/ref-frame.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import type { SessionStore } from '../core/session-store.ts';
import type { DaemonRequest } from '../index.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { selectorCaptureFixture } from '../__tests__/support/selector-capture-fixture.ts';
import {
  captureAndStoreSnapshot,
  commandSurfaceWithMembers,
} from '../__tests__/support/command-surface-override-fake.ts';

type SettleObservationOptions = Parameters<
  DaemonCommandSurface['interactions']['settleObservation']
>[0];

const settleObservationCalls: SettleObservationOptions[] = [];
const SETTLE_OBSERVATION: SettleObservation = {
  settled: true,
  waitedMs: 0,
  captures: 1,
  quietMs: 25,
  timeoutMs: 2_000,
  diff: {
    summary: { additions: 1, removals: 1, unchanged: 1 },
    lines: [
      { kind: 'added', text: 'Button "Load more"', ref: 'e2' },
      { kind: 'removed', text: 'Button "Continue"' },
    ],
  },
};

const testCreateCommandSurface = commandSurfaceWithMembers((config) => ({
  interactions: {
    settleObservation: async (options) => {
      settleObservationCalls.push(options);
      await captureAndStoreSnapshot(config, {
        session: options.session,
        requestId: options.requestId,
        signal: options.signal,
        includeRects: true,
        onlyStoreWhenSessionExists: true,
      });
      return {
        ...SETTLE_OBSERVATION,
        quietMs: options.quietMs ?? 500,
        timeoutMs: options.timeoutMs ?? 10_000,
      };
    },
  },
}));

// #1638 `--settle` on the GENERIC daemon route (scroll/back): the settled diff,
// its refs, and the ref-frame/generation dance are the same contract the touch
// commands get — but the baseline is the session's stored pre-action tree, not
// a resolution, and the observation must run after the deferred-outcome
// markers. Quiet windows are tuned down so no test waits real time.

vi.mock('./interaction/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./interaction/index.ts')>();
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

import { captureSnapshotForSession } from './interaction/index.ts';
import { dispatchGenericCommand } from './request-generic-dispatch.ts';
import { pendingSurfaceStabilization } from '../core/deferred-interaction-outcome.ts';

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
  waitedMs: number;
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
  ref: SessionRef,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  options: {
    interactiveOnly: boolean;
    boundCapture?: Parameters<typeof captureSnapshotForSession>[4]['boundCapture'];
  },
) {
  captureObservations.push({
    postGestureStabilizationPending:
      pendingSurfaceStabilization(sessionStore.requireCurrent(ref)) !== undefined,
  });
  const effectiveFlags = { ...(flags ?? {}), snapshotInteractiveOnly: options.interactiveOnly };
  // Same rule the real seam applies: a request-bound capture is the tree this request reads, and
  // only a request that holds none dispatches for one (#3510).
  const snapshotData = options.boundCapture
    ? await options.boundCapture({})
    : ((await mockDispatch('snapshot')) as Parameters<typeof buildSnapshotState>[0]);
  const snapshot = buildSnapshotState(snapshotData ?? {}, effectiveFlags);
  const current = sessionStore.resolveCurrent(ref);
  if (current) setSessionSnapshot(current, snapshot);
  return snapshot;
}

function mockCommandDispatch(
  snapshots: RawSnapshotNode[][],
  producer: NonNullable<GenericSettleTree['producer']> = 'apple-runner',
) {
  let snapshotCalls = 0;
  mockDispatch.mockImplementation(async (command) => {
    if (command === 'snapshot') {
      const nodes = snapshots[Math.min(snapshotCalls, snapshots.length - 1)];
      snapshotCalls += 1;
      return { nodes, backend: 'xctest', producer };
    }
    return {};
  });
}

const contextFromFlags = () => ({}) as never;

/** Device work for the generic leaf under test. */
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
  overrides?: Partial<SessionState>,
): SessionState {
  const session = makeIosSession(sessionName, overrides);
  setSessionSnapshot(session, buildSnapshotState(snapshotPayload(baseline), {}));
  activateCompleteRefFrame(session);
  sessionStore.publish(sessionName, session);
  return session;
}

/** A tree plus the surface a capture of it describes: app content, or an in-place system surface. */
type GenericSettleTree = {
  nodes: RawSnapshotNode[];
  systemSurface?: IosSystemSurfaceProvenance;
  producer?: 'apple-runner' | 'simulator-ax-bridge';
  presentedSurface?: PresentedSurface;
};

function snapshotPayload(tree: GenericSettleTree) {
  return {
    nodes: tree.nodes,
    backend: 'xctest' as const,
    producer: tree.producer ?? ('apple-runner' as const),
    ...(tree.systemSurface ? { systemSurface: tree.systemSurface } : {}),
    ...(tree.presentedSurface ? { presentedSurface: tree.presentedSurface } : {}),
  };
}

/**
 * The default gateway these cases run against: an owner whose settle captures arrive through the
 * emulated `captureSnapshotForSession` this file drives, i.e. one whose bound capture plan is
 * refused. The cases that pin the admitted capture name their own fixture (#3510).
 */
function legacyCaptureRuntimeBindings() {
  return selectorCaptureFixture({
    capture: { available: false, reason: 'unsupported-platform-leaf' },
    withoutActiveApp: { available: false, reason: 'unsupported-platform-leaf' },
  });
}

async function dispatchGeneric(params: {
  sessionName: string;
  sessionStore: SessionStore;
  command: string;
  positionals?: string[];
  flags?: CommandFlags;
  /** The request-scoped runtime seams `--settle` admits its own observation capture through. */
  runtimeBindings?: Readonly<
    Pick<Parameters<typeof dispatchGenericCommand>[0], 'inspectFacts' | 'bindDevice'>
  >;
}): Promise<DaemonResponse> {
  const req: DaemonRequest = {
    token: 't',
    session: params.sessionName,
    command: params.command,
    positionals: params.positionals ?? [],
    ...(params.flags ? { flags: params.flags } : {}),
  };
  return await dispatchGenericCommand({
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    ref: params.sessionStore.lookup(params.sessionName)!,
    sessionName: params.sessionName,
    logPath: '',
    sessionStore: params.sessionStore,
    contextFromFlags,
    executePlatformCommand: platformExecution,
    ...legacyCaptureRuntimeBindings(),
    ...params.runtimeBindings,
  });
}

function expectOkData(response: DaemonResponse): Record<string, unknown> {
  expect(response.ok).toBe(true);
  if (response.ok !== true) throw new Error('expected an ok daemon response');
  return (response.data ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  captureObservations.length = 0;
  settleObservationCalls.length = 0;
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(
    (...args: Parameters<typeof captureSnapshotForSession>) => {
      const [ref, flags, sessionStore, _contextFromFlags, options] = args;
      return emulateCaptureSnapshotForSession(ref, flags, sessionStore, options);
    },
  );
});

test('scroll --settle passes the stored baseline and attaches the observation with its issued refs', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-scroll';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch([AFTER_NODES]);

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  const settle = expectOkData(response).settle as SettlePayload;
  expect(settle).toMatchObject(SETTLE_OBSERVATION);
  expect(settleObservationCalls).toHaveLength(1);
  expect(settleObservationCalls[0]?.baseline.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Continue' })]),
  );

  const stored = sessionStore.get(sessionName) as SessionState;
  expect(stored.snapshot?.nodes.some((node) => node.label === 'Load more')).toBe(true);
  expect(refFrameState(stored)).toBe('active');
  expect(settle.refsGeneration).toBe(stored.snapshotGeneration);
});

test('back --settle attaches the observation alongside the command result', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-back';
  seedSession(sessionName, sessionStore);
  mockDispatch.mockImplementation(async (command) => {
    if (command === 'snapshot')
      return { nodes: AFTER_NODES, backend: 'xctest', producer: 'apple-runner' };
    return { action: 'back', mode: 'in-app', message: 'Back' };
  });

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'back',
    flags: { ...SETTLE_FLAGS },
  });

  const data = expectOkData(response);
  expect(data.action).toBe('back');
  expect(data.message).toBe('Back');
  expect(data.settle).toMatchObject(SETTLE_OBSERVATION);
});

test('generic settle preserves the stored surface facts on its baseline', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-surface-baseline';
  seedSession(sessionName, sessionStore, {
    nodes: BEFORE_NODES,
    systemSurface: { bundleId: 'com.apple.SafariViewService', kind: 'web-auth' },
    presentedSurface: 'presented',
  });
  mockCommandDispatch([AFTER_NODES]);

  await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  expect(settleObservationCalls[0]?.baseline).toMatchObject({
    surfaceBundleId: 'com.apple.SafariViewService',
    presentedSurface: 'presented',
  });
  expect(settleObservationCalls[0]?.baseline.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Continue' })]),
  );
});

test('generic settle drops an outdated presented-surface fact but keeps its stored nodes', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-outdated-baseline';
  const session = seedSession(sessionName, sessionStore, {
    nodes: BEFORE_NODES,
    systemSurface: { bundleId: 'com.apple.SafariViewService', kind: 'web-auth' },
    presentedSurface: 'absent',
  });
  markSessionSnapshotOutdated(session);
  mockCommandDispatch([AFTER_NODES]);

  await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'back',
    flags: { ...SETTLE_FLAGS },
  });

  expect(settleObservationCalls[0]?.baseline).toMatchObject({
    surfaceBundleId: 'com.apple.SafariViewService',
  });
  expect(settleObservationCalls[0]?.baseline.presentedSurface).toBeUndefined();
  expect(settleObservationCalls[0]?.baseline.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Continue' })]),
  );
});

test('the settle observation runs after the post-gesture stabilization marker', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-order';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch([AFTER_NODES]);

  await dispatchGeneric({
    sessionName,
    sessionStore,
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

test('scroll --settle observes through the request-bound capture, once admitted', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-bound-capture';
  // A tracked app: the plan this request must admit is the active-app one. The fixture refuses the
  // without-active-app plan, so an observation that resolved the wrong cell would degrade to the
  // legacy dispatch below and fail these assertions rather than pass by accident.
  seedSession(
    sessionName,
    sessionStore,
    { nodes: BEFORE_NODES },
    { appBundleId: 'com.example.app' },
  );
  mockCommandDispatch([AFTER_NODES]);
  const runtimeBindings = selectorCaptureFixture({
    withoutActiveApp: { available: false, reason: 'owner-capability-missing' },
    snapshot: () => ({
      nodes: AFTER_NODES,
      backend: 'xctest',
      producer: 'simulator-ax-bridge',
    }),
  });

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
    runtimeBindings,
  });

  const settle = expectOkData(response).settle as SettlePayload;
  expect(settle.settled).toBe(true);
  // One admit-and-bind for the whole observation, and every capture taken through it: the settled
  // tree and the tree the caller's next `snapshot` reads are the same producer's output (#3510).
  expect(runtimeBindings.binds.length).toBe(1);
  expect(runtimeBindings.captures.length).toBe(settle.captures);
  expect(mockDispatch).not.toHaveBeenCalledWith('snapshot');
  expect((sessionStore.get(sessionName) as SessionState).snapshot?.producer).toBe(
    'simulator-ax-bridge',
  );
});

test('scroll --settle still observes when the owner cannot capture', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-unbound-capture';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch([AFTER_NODES]);
  const runtimeBindings = selectorCaptureFixture({
    capture: { available: false, reason: 'unsupported-platform-leaf' },
  });

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
    runtimeBindings,
  });

  // The owner's own snapshot path is its only snapshot path: the observation stays complete and
  // nothing pretends a second capture implementation produced it.
  expect(expectOkData(response).settle).toMatchObject({ settled: true });
  expect(runtimeBindings.binds).toEqual([]);
  expect(mockDispatch).toHaveBeenCalledWith('snapshot');
});

test('scroll without --settle takes no observation captures and issues no refs', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-off';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch([AFTER_NODES]);
  const runtimeBindings = selectorCaptureFixture();

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    runtimeBindings,
  });

  expect(expectOkData(response).settle).toBeUndefined();
  expect(captureObservations).toEqual([]);
  // Settling is what asks for an observation capture, so a plain scroll never pays for one.
  expect(runtimeBindings.binds).toEqual([]);
  // ADR 0014: the leaf side-effect seam expired the frame and nothing
  // re-published it.
  expect(refFrameState(sessionStore.get(sessionName) as SessionState)).toBe('expired');
});

test('an ended generic lifetime is refused before dispatch or settle construction', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-evicted';
  seedSession(sessionName, sessionStore);
  const ref = sessionStore.lookup(sessionName)!;
  sessionStore.retire(ref);
  mockCommandDispatch([AFTER_NODES]);
  await expect(
    dispatchGenericCommand({
      createCommandSurface: testCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: {
        token: 't',
        session: sessionName,
        command: 'scroll',
        positionals: ['down'],
        flags: SETTLE_FLAGS,
      },
      ref,
      sessionName,
      sessionStore,
      logPath: '',
      contextFromFlags,
      executePlatformCommand: platformExecution,
      ...legacyCaptureRuntimeBindings(),
    }),
  ).rejects.toMatchObject({ details: { reason: 'session_lifetime_ended' } });
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(captureObservations).toEqual([]);
});

test('a generic command without the observation trait ignores a stray settle flag', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-traitless';
  seedSession(sessionName, sessionStore);
  mockDispatch.mockResolvedValue({ action: 'home', message: 'Home' });

  // A hand-built daemon request can put settle flags on any command; only the
  // descriptor trait admits them to the observation path. `home` has no trait,
  // so the flag is ignored: no captures, no settle payload, no rejection.
  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'home',
    flags: { settle: true },
  });

  expect(expectOkData(response).settle).toBeUndefined();
  expect(captureObservations).toEqual([]);
});

test('an orphaned --settle-quiet is rejected before the command dispatches', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-orphan';
  seedSession(sessionName, sessionStore);
  mockDispatch.mockRejectedValue(new Error('dispatch must not run for an orphaned settle flag'));

  const response = await dispatchGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { settleQuietMs: 25 },
  });

  expect(response.ok).toBe(false);
  if (response.ok !== false) throw new Error('expected a rejected daemon response');
  expect(response.error?.code).toBe('INVALID_ARGS');
  expect(response.error?.message).toContain('--settle-quiet');
});

test('scroll stays successful when its lifetime retires during optional settle observation', async () => {
  const store = makeSessionStore();
  const name = 'generic-settle-retired';
  seedSession(name, store);
  const ref = store.lookup(name)!;
  mockCommandDispatch([AFTER_NODES]);
  mockCaptureSnapshotForSession.mockImplementationOnce(
    async (boundRef, flags, sessionStore, _context, options) => {
      const observed = await emulateCaptureSnapshotForSession(
        boundRef,
        flags,
        sessionStore,
        options,
      );
      queueMicrotask(() => {
        store.retire(ref);
        store.publish(name, makeIosSession(name));
      });
      return observed;
    },
  );
  const response = await dispatchGeneric({
    sessionName: name,
    sessionStore: store,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });
  expect(expectOkData(response).settle).toBeUndefined();
  expect(store.get(name)?.snapshot).toBeUndefined();
  expect(store.get(name)?.actions).toEqual([]);
});

for (const change of ['rebuild', 'retire'] as const) {
  test(`held generic settle capture respects its lifetime after ${change}`, async () => {
    const store = makeSessionStore();
    const name = `generic-held-settle-${change}`;
    seedSession(name, store);
    const ref = store.lookup(name)!;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockDispatch.mockImplementation(async (command) => {
      if (command !== 'snapshot') return {};
      entered();
      await held;
      return snapshotPayload({ nodes: AFTER_NODES });
    });
    const pending = dispatchGeneric({
      sessionName: name,
      sessionStore: store,
      command: 'scroll',
      positionals: ['down'],
      flags: { ...SETTLE_FLAGS },
    });
    try {
      await reached;
      const trace = { outPath: 'latest-trace', startedAt: 1 };
      const successor = makeIosSession(name);
      if (change === 'rebuild') store.update(ref, { trace });
      else {
        store.retire(ref);
        store.publish(name, successor);
      }
      release();
      const data = expectOkData(await pending);
      if (change === 'rebuild') {
        expect(store.requireCurrent(ref).trace).toBe(trace);
        expect(store.requireCurrent(ref).snapshot?.nodes[1]?.label).toBe('Load more');
      } else {
        expect(data.settle).toBeUndefined();
        expect(store.get(name)).toBe(successor);
        expect(successor.snapshot).toBeUndefined();
      }
    } finally {
      release();
      await pending;
    }
  });
}
