import { test, expect, vi, beforeEach } from 'vitest';
import { handleInteractionCommands } from '../interaction.ts';
import type { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';
import type { CommandFlags } from '../../../core/dispatch.ts';
import type { SnapshotBackend } from '../../../kernel/snapshot.ts';
import { buildSnapshotState } from '../snapshot-capture.ts';
import { setSessionSnapshot } from '../../session-snapshot.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';

// #1101 --settle daemon response shape: the settle payload (diff + settled +
// refsGeneration) rides the wire response through the shared builder, and a
// diff-carrying settle response is ref-issuing (clears snapshotRefsStale).
// Quiet windows are tuned down (--settle-quiet 25) so no test waits real time
// beyond a few poll ticks.

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

vi.mock('../interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-snapshot.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(async () => ({
      nodes: [],
      createdAt: 0,
      backend: 'xctest' as const,
    })),
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import { captureSnapshotForSession } from '../interaction-snapshot.ts';
const mockDispatch = vi.mocked(dispatchCommand);
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
    type: 'StaticText',
    label: 'Welcome!',
    rect: { x: 10, y: 20, width: 120, height: 44 },
    hittable: true,
  },
];

async function emulateCaptureSnapshotForSession(
  session: SessionState,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  contextFromFlags: (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ) => Record<string, unknown>,
  options: { interactiveOnly: boolean },
) {
  const effectiveFlags = { ...(flags ?? {}), snapshotInteractiveOnly: options.interactiveOnly };
  const snapshotData = (await mockDispatch(
    session.device,
    'snapshot',
    [],
    effectiveFlags.out,
    contextFromFlags(effectiveFlags, session.appBundleId, session.trace?.outPath),
  )) as { nodes?: never[]; truncated?: boolean; backend?: SnapshotBackend };
  const snapshot = buildSnapshotState(snapshotData ?? {}, effectiveFlags);
  setSessionSnapshot(session, snapshot);
  sessionStore.set(session.name, session);
  return snapshot;
}

function seedSession(sessionName: string, sessionStore: ReturnType<typeof makeSessionStore>) {
  const session = makeIosSession(sessionName);
  setSessionSnapshot(session, buildSnapshotState({ nodes: BEFORE_NODES, backend: 'xctest' }, {}));
  // The seed emulates a snapshot response that issued these refs.
  session.snapshotRefsStale = false;
  sessionStore.set(sessionName, session);
  return session;
}

function mockCommandDispatch(params: { snapshots: Array<typeof BEFORE_NODES> }) {
  let snapshotCalls = 0;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      const nodes = params.snapshots[Math.min(snapshotCalls, params.snapshots.length - 1)];
      snapshotCalls += 1;
      return { nodes, backend: 'xctest' };
    }
    return {};
  });
}

const contextFromFlags = () => ({});

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(emulateCaptureSnapshotForSession);
});

const SETTLE_FLAGS = { settle: true, settleQuietMs: 25, timeoutMs: 2_000 };

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
  tailTruncated?: boolean;
  hint?: string;
};

function expectOkData(
  response: Awaited<ReturnType<typeof handleInteractionCommands>>,
): Record<string, unknown> {
  expect(response?.ok).toBe(true);
  if (!response || response.ok !== true) throw new Error('expected an ok daemon response');
  return (response.data ?? {}) as Record<string, unknown>;
}

function expectInvalidArgs(
  response: Awaited<ReturnType<typeof handleInteractionCommands>>,
): Record<string, unknown> {
  expect(response?.ok).toBe(false);
  if (!response || response.ok !== false) throw new Error('expected an invalid daemon response');
  expect(response.error?.code).toBe('INVALID_ARGS');
  return (response.error ?? {}) as Record<string, unknown>;
}

test('press --settle responds with the settled diff, refsGeneration, and clears the stale marker', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'settle-press';
  seedSession(sessionName, sessionStore);
  // Resolution capture sees the pre-action tree; settle captures see the
  // settled post-action tree.
  mockCommandDispatch({ snapshots: [BEFORE_NODES, AFTER_NODES, AFTER_NODES, AFTER_NODES] });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['label=Continue'],
      flags: { ...SETTLE_FLAGS },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  const data = expectOkData(response);
  const settle = data.settle as SettlePayload;
  expect(settle).toBeTruthy();
  expect(settle.settled).toBe(true);
  expect(settle.quietMs).toBe(25);
  expect(settle.timeoutMs).toBe(2_000);
  const diff = settle.diff as NonNullable<SettlePayload['diff']>;
  expect(diff.summary).toEqual({ additions: 1, removals: 1, unchanged: 1 });
  const added = diff.lines.find((line) => line.kind === 'added');
  expect(added).toEqual({ kind: 'added', text: expect.stringContaining('Welcome!'), ref: 'e2' });

  const session = sessionStore.get(sessionName) as SessionState;
  // The settle response handed the settled tree's refs to the client: the
  // coarse marker clears and the payload carries the stored generation.
  expect(session.snapshotRefsStale).toBe(false);
  expect(settle.refsGeneration).toBe(session.snapshotGeneration);
  // The settled tree became the stored session snapshot.
  expect(session.snapshot?.nodes.some((node) => node.label === 'Welcome!')).toBe(true);
});

const MODAL_BEFORE_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    rect: { x: 10, y: 20, width: 120, height: 44 },
    hittable: true,
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'Button',
    label: 'OK',
    rect: { x: 10, y: 100, width: 120, height: 44 },
    hittable: true,
  },
];

// Modal dismissed: Continue survives unchanged, OK is gone — a removals-only
// diff with nothing added.
const MODAL_AFTER_NODES = [
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

test('press --settle on a removals-only diff attaches the unchanged interactive tail at the diff generation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'settle-tail';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch({
    snapshots: [MODAL_BEFORE_NODES, MODAL_AFTER_NODES, MODAL_AFTER_NODES],
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['label=OK'],
      flags: { ...SETTLE_FLAGS },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  const data = expectOkData(response);
  const settle = data.settle as SettlePayload;
  expect(settle.diff?.summary).toEqual({ additions: 0, removals: 1, unchanged: 2 });
  expect(settle.diff?.lines.some((line) => line.kind === 'added')).toBe(false);
  expect(settle.tail).toEqual([{ ref: 'e2', role: 'button', label: 'Continue' }]);
  // Same generation as the diff: the tail rides the settled tree that was
  // just stored as the session snapshot.
  const session = sessionStore.get(sessionName) as SessionState;
  expect(settle.refsGeneration).toBe(session.snapshotGeneration);
});

test('press --settle keeps the stale-refs input warning while re-issuing fresh refs', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'settle-stale-ref';
  const session = seedSession(sessionName, sessionStore);
  session.snapshotRefsStale = true;
  sessionStore.set(sessionName, session);
  mockCommandDispatch({ snapshots: [AFTER_NODES, AFTER_NODES] });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e2'],
      flags: { ...SETTLE_FLAGS },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  const data = expectOkData(response);
  // The @ref was consumed while stale — the input warning stands…
  expect(String(data.warning)).toMatch(/refs were issued/);
  // …and the settled diff re-issues refs, so the NEXT @ref command is clean.
  expect(sessionStore.get(sessionName)?.snapshotRefsStale).toBe(false);
});

test('a settle observation without a diff leaves ref staleness untouched', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'settle-stalled';
  seedSession(sessionName, sessionStore);
  let snapshotCalls = 0;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return { nodes: BEFORE_NODES, backend: 'xctest' };
      throw new Error('AX bridge crashed');
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['label=Continue'],
      flags: { ...SETTLE_FLAGS },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  // The press still succeeds; the observation reports its own failure.
  const data = expectOkData(response);
  const settle = data.settle as SettlePayload;
  expect(settle.settled).toBe(false);
  expect(settle.diff).toBeUndefined();
  expect(settle.hint).toMatch(/Settle observation unavailable/);
  // No refs were issued: the resolution capture left the marker stale.
  expect(sessionStore.get(sessionName)?.snapshotRefsStale).toBe(true);
});

test('bare timeout without --settle stays compatible', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'settle-guard';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch({ snapshots: [BEFORE_NODES] });

  const compatible = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['label=Continue'],
      flags: { timeoutMs: 2_000 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  const data = expectOkData(compatible);
  expect(data.settle).toBeUndefined();
});

test('settle-specific tuning flags without --settle are rejected', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'settle-guard';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch({ snapshots: [BEFORE_NODES] });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['label=Continue'],
      flags: { settleQuietMs: 25 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  const error = expectInvalidArgs(response);
  expect(error.message).toMatch(/--settle-quiet requires --settle/);
});

test('fill @ref --settle carries the settle payload on the ref wire shape', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'settle-fill';
  seedSession(sessionName, sessionStore);
  mockCommandDispatch({ snapshots: [AFTER_NODES, AFTER_NODES] });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e2', 'hello'],
      flags: { ...SETTLE_FLAGS },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  const data = expectOkData(response);
  const settle = data.settle as SettlePayload;
  expect(settle.settled).toBe(true);
  expect(typeof settle.refsGeneration).toBe('number');
});
