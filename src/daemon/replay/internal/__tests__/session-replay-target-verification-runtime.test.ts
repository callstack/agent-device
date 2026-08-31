/**
 * ADR 0012 migration step 4, end-to-end: `runReplayCommand` must consult
 * `verifyReplayActionTarget` for every annotated resolved-target action
 * BEFORE dispatching it, and never send the device action on a non-verified
 * outcome. Mirrors the mocking pattern of `session-replay-runtime.test.ts`
 * (adapt mocked `dispatchCommand` through the narrow snapshot interactor seam, mock `invoke`
 * for the actual action dispatch).
 */
import { test, expect, vi, beforeEach } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../core/dispatch-resolve.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});

vi.mock('../../../handlers/snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

// #1385's pre-dispatch launch-race retry (captureDivergenceObservation's
// `retryLaunchRace`) awaits a real `sleep` between attempts; stub it to a
// no-op so the retry tests below exercise the retry BRANCH (still runs each
// mocked capture attempt) without a real wall-clock wait (repo guidance: unit
// tests must not wait real time).
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import path from 'node:path';
import type { DaemonRequest } from '../../../types.ts';
import { runReplayForTest } from '../../__tests__/replay-command-fixture.ts';
import { SessionStore } from '../../../session-store.ts';
import { AppError } from '@agent-device/kernel/errors';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from '../../__tests__/session-replay-runtime.fixtures.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../handlers/snapshot-interactor-capture.ts';

const mockDispatchCommand = legacyDispatchCapture;
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  resetLegacySnapshotCapture(mockCaptureSnapshotWithInteractor);
});

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

const UNVERIFIABLE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"unverifiable"}';

const DRAG_ANNOTATION = `# agent-device:targets-v1 ${JSON.stringify({
  source: {
    id: 'source',
    role: 'view',
    label: 'Source',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  },
  destination: {
    id: 'destination',
    role: 'view',
    label: 'Drop',
    ancestry: [],
    sibling: 1,
    viewportOrder: 0,
    verification: 'verified',
  },
})}`;

const DRAG_NODES = [
  {
    index: 0,
    depth: 0,
    type: 'View',
    identifier: 'source',
    label: 'Source',
    rect: { x: 10, y: 10, width: 40, height: 20 },
  },
  {
    index: 1,
    depth: 0,
    type: 'View',
    identifier: 'destination',
    label: 'Drop',
    rect: { x: 100, y: 100, width: 40, height: 20 },
  },
];

function setupSession(root: string): { sessionStore: SessionStore; sessionName: string } {
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return { sessionStore, sessionName };
}

test('an unannotated action executes unchanged (old-script pass-through)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-passthrough-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, ['click id="save"']);

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked.map((req) => req.command)).toEqual(['click']);
  // The pre-action snapshot-capture path (captureDivergenceObservation) is
  // never reached for an unannotated action.
  expect(mockDispatchCommand).not.toHaveBeenCalled();
});

test('a verified target proceeds to dispatch the action', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-verified-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked.map((req) => req.command)).toEqual(['click']);
  expect(invoked[0]?.positionals).toEqual(['id="save"']);
});

test('a verified drag guards both source and destination before dispatch', async () => {
  const root = mkdtempForTestSync('agent-device-replay-drag-guards-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [
    DRAG_ANNOTATION,
    'gesture drag id="source" id="destination" 800 500 0',
  ]);
  mockDispatchCommand.mockResolvedValue({ nodes: DRAG_NODES, backend: 'xctest' });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked).toHaveLength(1);
  expect(invoked[0]?.internal?.replayTargetGuards).toMatchObject({
    source: { identity: { id: 'source', label: 'Source' } },
    destination: { identity: { id: 'destination', label: 'Drop' } },
  });
});

test('a shifted drag destination diverges before pointer-down even when the source still matches', async () => {
  const root = mkdtempForTestSync('agent-device-replay-drag-destination-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [
    DRAG_ANNOTATION,
    'gesture drag id="source" label="Drop" 800 500 0',
  ]);
  mockDispatchCommand.mockResolvedValue({
    nodes: [DRAG_NODES[0]!, { ...DRAG_NODES[1]!, identifier: 'different-destination' }],
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked).toHaveLength(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-mismatch');
  expect(divergence.targetBinding).toMatchObject({
    recorded: { id: 'destination', role: 'view', label: 'Drop' },
    observed: { id: 'different-destination', role: 'view', label: 'Drop' },
  });
});

test('a destination guard refusal reports destination evidence after both preflight checks pass', async () => {
  const root = mkdtempForTestSync('agent-device-replay-drag-guard-refusal-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [
    DRAG_ANNOTATION,
    'gesture drag id="source" id="destination" 800 500 0',
  ]);
  mockDispatchCommand.mockResolvedValue({ nodes: DRAG_NODES, backend: 'xctest' });

  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'drag destination resolved to a different element',
        details: {
          reason: 'replay_target_guard_mismatch',
          targetRole: 'destination',
          observed: { id: 'decoy', role: 'view', label: 'Drop' },
          expected: { id: 'destination', role: 'view', label: 'Drop' },
        },
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.targetBinding).toMatchObject({
    recorded: { id: 'destination', role: 'view', label: 'Drop' },
    observed: { id: 'decoy', role: 'view', label: 'Drop' },
  });
});

test('a selector-miss divergence blocks dispatch and never sends the action', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-miss-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  // The pre-action capture finds an entirely empty tree: the recorded
  // selector no longer matches anything.
  mockDispatchCommand.mockResolvedValue({ nodes: [], truncated: false, backend: 'xctest' });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0); // the click action was never dispatched
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('selector-miss');
  const targetBinding = divergence.targetBinding as Record<string, unknown>;
  expect(targetBinding.classification).toBe('selector-miss');
  expect(targetBinding.matchCount).toBe(0);
  expect(targetBinding.observed).toBeUndefined();
  expect(targetBinding.recorded).toEqual({ id: 'save', role: 'button', label: 'Save' });
});

test('an identity-mismatch divergence reports matchCount and an observed identity', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-mismatch-');
  const { sessionStore, sessionName } = setupSession(root);
  // A label-based selector so it can match a node whose id changed.
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click label="Save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save-v2', // renamed id: no longer matches the recorded 'save'
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-mismatch');
  const targetBinding = divergence.targetBinding as Record<string, unknown>;
  expect(targetBinding.classification).toBe('identity-mismatch');
  expect(targetBinding.matchCount).toBe(1);
  expect(targetBinding.observed).toEqual({ id: 'save-v2', role: 'button', label: 'Save' });
  expect(Array.isArray(targetBinding.mismatches)).toBe(true);
  expect((targetBinding.mismatches as string[]).length).toBeGreaterThan(0);
  // Real computed resume (shared builder): pre-action divergence at step 1
  // resumes AT the failed step with a concrete plan digest, never the stub.
  const resume = divergence.resume as { allowed: boolean; from?: number; planDigest?: string };
  expect(resume.allowed).toBe(true);
  expect(resume.from).toBe(1);
  expect(typeof resume.planDigest).toBe('string');
  expect((resume.planDigest ?? '').length).toBeGreaterThan(0);
});

test('a recorded-unverifiable annotation is an identity-unverifiable divergence with matchCount omitted', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-unverifiable-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [UNVERIFIABLE_ANNOTATION, 'click id="save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-unverifiable');
  const targetBinding = divergence.targetBinding as Record<string, unknown>;
  expect(targetBinding.classification).toBe('identity-unverifiable');
  expect('matchCount' in targetBinding).toBe(false);
});

test('a verified annotated action carries the post-resolution guard on its dispatch request', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-guard-thread-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  // The verified member's normalized identity AND structural denotation ride
  // the request so dispatch's own resolution can cross-check its winner
  // pre-action — the structural part distinguishes a same-identity duplicate.
  expect(invoked[0]?.internal?.replayTargetGuard).toEqual({
    identity: { id: 'save', role: 'button', label: 'Save' },
    structural: { documentOrder: 0, sibling: 0 },
  });
});

test('an unannotated action never carries a post-resolution guard', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-guard-none-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, ['click id="save"']);

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked[0]?.internal?.replayTargetGuard).toBeUndefined();
});

test('a dispatch-time guard mismatch converts to an identity-mismatch target-binding divergence', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-guard-mismatch-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  // Pre-action verification passes against this tree (guard minted)...
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      // ...but dispatch's own resolution (occlusion/visibility guards) landed
      // on a different element and refused pre-action with the guard marker.
      return {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'click resolved to a different element than replay verification isolated',
          details: {
            reason: 'replay_target_guard_mismatch',
            observed: { id: 'save-decoy', role: 'button', label: 'Save' },
            expected: { id: 'save', role: 'button', label: 'Save' },
          },
        },
      };
    },
  });

  expect(invoked.length).toBe(1); // dispatched once; the refusal was pre-action inside dispatch
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-mismatch');
  const targetBinding = divergence.targetBinding as Record<string, unknown>;
  expect(targetBinding.classification).toBe('identity-mismatch');
  // matchCount from verification's recorded-selector resolution (presence rule:
  // resolution happened, so the key is present).
  expect(targetBinding.matchCount).toBe(1);
  expect(targetBinding.recorded).toEqual({ id: 'save', role: 'button', label: 'Save' });
  expect(targetBinding.observed).toEqual({ id: 'save-decoy', role: 'button', label: 'Save' });
  expect((targetBinding.mismatches as string[]).some((entry) => entry.includes('save-decoy'))).toBe(
    true,
  );
  // The guard-mismatch path funnels through the same shared builder: it must
  // also carry a real computed resume (from = the failed step), not the stub.
  const resume = divergence.resume as { allowed: boolean; from?: number; planDigest?: string };
  expect(resume.allowed).toBe(true);
  expect(resume.from).toBe(1);
  expect(typeof resume.planDigest).toBe('string');
  expect((resume.planDigest ?? '').length).toBeGreaterThan(0);
});

test('a same-identity guard mismatch surfaces the structural position difference in the divergence', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-guard-struct-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    // Dispatch refused a DIFFERENT DUPLICATE with IDENTICAL local identity —
    // the refusal is driven purely by the structural denotation.
    invoke: async () => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'click resolved to a different element than replay verification isolated',
        details: {
          reason: 'replay_target_guard_mismatch',
          observed: { id: 'save', role: 'button', label: 'Save' },
          expected: { id: 'save', role: 'button', label: 'Save' },
          observedStructural: { documentOrder: 2, sibling: 1 },
          expectedStructural: { documentOrder: 1, sibling: 0 },
        },
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-mismatch');
  const targetBinding = divergence.targetBinding as Record<string, unknown>;
  // Local identity is identical on both sides; the ONLY mismatch is structural.
  expect(targetBinding.observed).toEqual({ id: 'save', role: 'button', label: 'Save' });
  const mismatches = targetBinding.mismatches as string[];
  expect(mismatches.some((entry) => entry.startsWith('position:'))).toBe(true);
  expect(
    mismatches.some((entry) => entry.includes('doc1/sibling0') && entry.includes('doc2/sibling1')),
  ).toBe(true);
});

// NOTE: the "--update re-verifies a healed action" test was removed here —
// ADR 0012 migration step 6 (#1211) retired `--update` as an actor, so replay
// never heals/retries a step; there is no healed action to re-verify.

test('a target-binding divergence carries a real computed resume (step 5 wiring, not the retired stub)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-resume-');
  const { sessionStore, sessionName } = setupSession(root);
  // Two leading plain actions then the annotated (verified→miss) action at
  // step 3: a pre-action divergence resumes AT the failed step, and step 3 is
  // reachable because steps 1-2 produce no outputEnv and cross no control flow.
  const filePath = writeReplayFile(root, [
    'wait 10',
    'wait 10',
    SAVE_ANNOTATION,
    'click id="save"',
  ]);
  mockDispatchCommand.mockResolvedValue({ nodes: [], truncated: false, backend: 'xctest' });

  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('selector-miss');
  // Real computed resume: allowed AT the failed step (3), with a concrete
  // SHA-256 plan digest — NOT the retired `resume not yet supported` stub.
  const resume = divergence.resume as {
    allowed: boolean;
    from?: number;
    planDigest?: string;
    reason?: string;
  };
  expect(resume.allowed).toBe(true);
  expect(resume.from).toBe(3);
  expect(typeof resume.planDigest).toBe('string');
  expect((resume.planDigest ?? '').length).toBeGreaterThan(0);
  expect(resume.reason).toBeUndefined();
});

// #1385: a step-2 press right after `open --relaunch` can capture while the
// app is still launching/mounting. The bounded retry in
// `captureDivergenceObservation` (`retryLaunchRace`) only rides out a
// content-quality verdict — Android's helper path attaches
// `androidSnapshotHelperFailureReason` as one of exactly three literals
// ('empty-helper-output' | 'system-window-only' | 'content-poor-app-window')
// on that verdict (`rejectAndroidHelperContentUnavailable`) — never a
// mechanism failure (helper artifact missing, device offline, adb connection
// dropped), which must still fail fast even when the underlying error
// separately carries `retriable: true` for its own (adb-level, same-command)
// retry semantics. The three `throw*` helpers below build the three shapes
// this distinction must tell apart.
function throwContentQualityCaptureFailure(): never {
  throw new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper returned insufficient foreground app content',
    { androidSnapshotHelperFailureReason: 'content-poor-app-window', retriable: true },
  );
}

function throwPermanentCaptureFailure(): never {
  throw new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper is unavailable: the bundled helper artifact was not found',
  );
}

function throwAdbMechanismFailureMarkedRetriable(): never {
  // Mirrors `classifyAdbFailure`'s `connection_dropped` entry
  // (adb-executor.ts): `retriable: true` at the adb-transport level (retrying
  // the SAME adb command can succeed), but not evidence of a content-quality
  // capture verdict — a launch-race retry has no reason to believe THIS
  // failure resolves itself, and must not be fooled by the bare `retriable`
  // flag into treating it as one.
  throw new AppError('COMMAND_FAILED', 'adb: transport error', {
    adbFailure: 'connection_dropped',
    retriable: true,
  });
}

test('a transient content-quality capture failure right after launch recovers within the bounded retry, and the action still dispatches', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-launch-race-recover-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  // First two captures fail closed with a content-quality verdict (mirrors a
  // mid-launch/mid-mount capture); the third lands after the app settles and
  // finds the recorded target.
  mockDispatchCommand
    .mockImplementationOnce(async () => throwContentQualityCaptureFailure())
    .mockImplementationOnce(async () => throwContentQualityCaptureFailure())
    .mockResolvedValue({
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Button',
          identifier: 'save',
          label: 'Save',
          rect: { x: 10, y: 10, width: 40, height: 20 },
        },
      ],
      truncated: false,
      backend: 'xctest',
    });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked.map((req) => req.command)).toEqual(['click']);
  expect(mockDispatchCommand).toHaveBeenCalledTimes(3);
});

test('a content-quality capture failure that never recovers still fails closed as identity-unverifiable once the bounded retry is exhausted', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-launch-race-exhausted-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  mockDispatchCommand.mockImplementation(async () => throwContentQualityCaptureFailure());

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-unverifiable');
  const cause = divergence.cause as { code: string; message: string };
  expect(cause.code).toBe('IDENTITY_UNVERIFIABLE');
  expect(cause.message).toContain('capture-failed');
  // Bounded: the retry gives up after its fixed delay list, not forever.
  expect(mockDispatchCommand.mock.calls.length).toBeGreaterThan(1);
});

// #1385: the iOS side of the same launch race — the capture doesn't throw,
// it returns a structurally-valid tree flagged `sparse` (the private-AX
// fallback engaging under load). `isSparseSnapshotQualityVerdict` treats this
// as always-retryable, unlike the Android thrown-error branch, which is
// gated on the narrower content-quality taxonomy — so this needs its own
// regression, not just coverage by the Android capture-failed tests above.
function iosSparseCapture(): {
  nodes: never[];
  truncated: false;
  backend: 'xctest';
  quality: object;
} {
  return {
    nodes: [],
    truncated: false,
    backend: 'xctest',
    quality: { state: 'sparse', backend: 'private-ax', reason: 'AX query rejected mid-transition' },
  };
}

test('an iOS sparse-snapshot verdict right after launch recovers within the bounded retry, and the action still dispatches', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-launch-race-sparse-recover-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  // First two captures return a structurally-valid but sparse-flagged tree
  // (mirrors the private-AX fallback engaging mid-launch); the third lands
  // after the app settles and finds the recorded target.
  mockDispatchCommand
    .mockImplementationOnce(async () => iosSparseCapture())
    .mockImplementationOnce(async () => iosSparseCapture())
    .mockResolvedValue({
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Button',
          identifier: 'save',
          label: 'Save',
          rect: { x: 10, y: 10, width: 40, height: 20 },
        },
      ],
      truncated: false,
      backend: 'xctest',
    });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked.map((req) => req.command)).toEqual(['click']);
  expect(mockDispatchCommand).toHaveBeenCalledTimes(3);
});

test('an iOS sparse-snapshot verdict that never recovers still fails closed as identity-unverifiable once the bounded retry is exhausted', async () => {
  const root = mkdtempForTestSync(
    'agent-device-replay-target-verify-launch-race-sparse-exhausted-',
  );
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  mockDispatchCommand.mockImplementation(async () => iosSparseCapture());

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-unverifiable');
  const cause = divergence.cause as { code: string; message: string };
  expect(cause.code).toBe('IDENTITY_UNVERIFIABLE');
  expect(cause.message).toContain('sparse-snapshot');
  // Bounded: the retry gives up after its fixed delay list, not forever.
  expect(mockDispatchCommand.mock.calls.length).toBeGreaterThan(1);
});

test('a permanent (non-content-quality) capture failure fails fast without retrying', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-launch-race-permanent-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  // A missing helper artifact is not something a launch-race retry can fix —
  // it never carries `androidSnapshotHelperFailureReason` at all, so the
  // capture must fail on the FIRST attempt, not spend the retry budget on a
  // foregone conclusion.
  mockDispatchCommand.mockImplementation(async () => throwPermanentCaptureFailure());

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-unverifiable');
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
});

test('an adb mechanism failure marked retriable at the transport level still fails fast (retriable is not a content-quality signal)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-target-verify-launch-race-adb-mechanism-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  // A dropped adb connection carries `retriable: true` (retrying the SAME adb
  // command can succeed) but no `androidSnapshotHelperFailureReason` content
  // verdict — the launch-race retry must not treat the bare `retriable` flag
  // as proof this is a "the app is still mounting" content-quality failure.
  mockDispatchCommand.mockImplementation(async () => throwAdbMechanismFailureMarkedRetriable());

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-unverifiable');
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// #1349: wait's post-resolution landmark verification. An annotated selector
// wait must NEVER enter the generic pre-dispatch resolution path — polling is
// the command's own job — so the step loop only threads the recorded
// landmark and converts the loop's timeout refusal afterwards.
// ---------------------------------------------------------------------------

import { WAIT_LANDMARK_MISMATCH_REASON } from '@agent-device/contracts/replay';

const WAIT_ANNOTATION =
  '# agent-device:target-v1 {"role":"statictext","label":"Screen X","ancestry":[{"role":"other","label":"Detail Screen"}],"sibling":0,"viewportOrder":0,"verification":"verified"}';

const WAIT_UNVERIFIABLE_ANNOTATION =
  '# agent-device:target-v1 {"role":"statictext","label":"Screen X","ancestry":[{"role":"other","label":"Detail Screen"}],"sibling":0,"viewportOrder":0,"verification":"unverifiable"}';

test('an annotated selector wait dispatches with the landmark guard and no eager pre-action refusal', async () => {
  const root = mkdtempForTestSync('agent-device-replay-wait-landmark-thread-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [WAIT_ANNOTATION, 'wait "label=\\"Screen X\\"" 2000']);

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: { waitedMs: 300, selector: 'label="Screen X"' } };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked.map((req) => req.command)).toEqual(['wait']);
  expect(invoked[0]?.internal?.replayLandmarkGuard).toEqual({
    role: 'statictext',
    label: 'Screen X',
    ancestry: [{ role: 'other', label: 'Detail Screen' }],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  });
  expect(invoked[0]?.internal?.replayTargetGuard).toBeUndefined();
  // The landmark may legitimately be absent when the step starts: no
  // pre-action capture, no eager refusal.
  expect(mockDispatchCommand).not.toHaveBeenCalled();
});

test('a recorded-unverifiable wait annotation refuses before polling with matchCount omitted', async () => {
  const root = mkdtempForTestSync('agent-device-replay-wait-landmark-unverifiable-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [
    WAIT_UNVERIFIABLE_ANNOTATION,
    'wait "label=\\"Screen X\\"" 2000',
  ]);

  mockDispatchCommand.mockResolvedValue({ nodes: [], truncated: false, backend: 'xctest' });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-unverifiable');
  const targetBinding = divergence.targetBinding as Record<string, unknown>;
  expect('matchCount' in targetBinding).toBe(false);
});

test("the wait loop's landmark refusal converts into an identity-mismatch divergence", async () => {
  const root = mkdtempForTestSync('agent-device-replay-wait-landmark-miss-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [WAIT_ANNOTATION, 'wait "label=\\"Screen X\\"" 2000']);

  // The divergence screen capture after the refusal.
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'StaticText',
        label: 'Screen X',
        rect: { x: 0, y: 0, width: 100, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message:
            'wait matched selector label="Screen X" but no candidate carried the recorded landmark identity',
          details: {
            reason: WAIT_LANDMARK_MISMATCH_REASON,
            matchCount: 2,
            observed: { role: 'statictext', label: 'Screen X' },
            observedAncestry: [{ role: 'other', label: 'List Screen' }],
          },
        },
      };
    },
  });

  expect(invoked.map((req) => req.command)).toEqual(['wait']);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-mismatch');
  expect(divergence.repairHint).toBe('caution');
  const targetBinding = divergence.targetBinding as Record<string, unknown>;
  expect(targetBinding.classification).toBe('identity-mismatch');
  expect(targetBinding.matchCount).toBe(2);
  expect(targetBinding.recorded).toEqual({ role: 'statictext', label: 'Screen X' });
  expect(targetBinding.observed).toEqual({ role: 'statictext', label: 'Screen X' });
  const mismatches = targetBinding.mismatches as string[];
  expect(mismatches.some((entry) => entry.startsWith('ancestry[0]'))).toBe(true);
});

test('a plain wait timeout on an annotated wait stays an action-failure divergence', async () => {
  const root = mkdtempForTestSync('agent-device-replay-wait-plain-timeout-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [WAIT_ANNOTATION, 'wait "label=\\"Screen X\\"" 2000']);

  mockDispatchCommand.mockResolvedValue({ nodes: [], truncated: false, backend: 'xctest' });

  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'wait timed out for selector: label="Screen X"',
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('action-failure');
});

test('an annotation on a duration wait is inert (no guard, no refusal)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-wait-duration-inert-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [WAIT_UNVERIFIABLE_ANNOTATION, 'wait 500']);

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: { waitedMs: 500 } };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked.map((req) => req.command)).toEqual(['wait']);
  expect(invoked[0]?.internal?.replayLandmarkGuard).toBeUndefined();
  expect(mockDispatchCommand).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// #1349: `is` joins the generic pre-dispatch verification path (get-pattern).
// ---------------------------------------------------------------------------

const IS_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

test('an annotated is step verifies pre-dispatch and threads the post-resolution guard', async () => {
  const root = mkdtempForTestSync('agent-device-replay-is-verified-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [IS_ANNOTATION, 'is visible id="save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: { predicate: 'visible', pass: true } };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked.map((req) => req.command)).toEqual(['is']);
  expect(invoked[0]?.internal?.replayTargetGuard).toMatchObject({
    identity: { id: 'save', role: 'button', label: 'Save' },
  });
});

test('an annotated is step whose recorded identity vanished diverges before dispatch', async () => {
  const root = mkdtempForTestSync('agent-device-replay-is-mismatch-');
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [IS_ANNOTATION, 'is visible label="Save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save-v2',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayForTest({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(invoked.length).toBe(0);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.kind).toBe('identity-mismatch');
});
