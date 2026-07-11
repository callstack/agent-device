/**
 * ADR 0012 migration step 4, end-to-end: `runReplayScriptFile` must consult
 * `verifyReplayActionTarget` for every annotated resolved-target action
 * BEFORE dispatching it, and never send the device action on a non-verified
 * outcome. Mirrors the mocking pattern of `session-replay-runtime.test.ts`
 * (mock `dispatchCommand` for the pre-action snapshot capture, mock `invoke`
 * for the actual action dispatch).
 */
import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest } from '../../types.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});

function writeReplayFile(root: string, lines: string[]): string {
  const filePath = path.join(root, 'flow.ad');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function baseReq(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return { token: 'token', session: 'default', command: 'replay', positionals: [], ...overrides };
}

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

const UNVERIFIABLE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"unverifiable"}';

function setupSession(root: string): { sessionStore: SessionStore; sessionName: string } {
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return { sessionStore, sessionName };
}

test('an unannotated action executes unchanged (old-script pass-through)', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-target-verify-passthrough-'),
  );
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, ['click id="save"']);

  const invoked: DaemonRequest[] = [];
  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-target-verify-verified-'),
  );
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
  const response = await runReplayScriptFile({
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

test('a selector-miss divergence blocks dispatch and never sends the action', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-target-verify-miss-'));
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [SAVE_ANNOTATION, 'click id="save"']);

  // The pre-action capture finds an entirely empty tree: the recorded
  // selector no longer matches anything.
  mockDispatchCommand.mockResolvedValue({ nodes: [], truncated: false, backend: 'xctest' });

  const invoked: DaemonRequest[] = [];
  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-target-verify-mismatch-'),
  );
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
  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-target-verify-unverifiable-'),
  );
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
  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-target-guard-thread-'));
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
  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-target-guard-none-'));
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, ['click id="save"']);

  const invoked: DaemonRequest[] = [];
  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-target-guard-mismatch-'));
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
  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-target-guard-struct-'));
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

  const response = await runReplayScriptFile({
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-target-resume-'));
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

  const response = await runReplayScriptFile({
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
