/**
 * Regression coverage for the merged-main divergence (surfaced by the #1210
 * architecture-consolidation merge): a raw dispatch selector-miss during
 * press/click/fill/longpress THROWS an AppError instead of resolving to
 * `{ok:false}`. `invokeReplayAction` (session-replay-action-runtime.ts)
 * previously let that throw escape the per-action `if (!response.ok)`
 * handling in `runReplayScriptFile`'s loop, so it hit the outer catch and
 * returned a bare `COMMAND_FAILED` with the legacy diagnostics shape instead
 * of the ADR 0012 `REPLAY_DIVERGENCE` report — breaking the interactive
 * repair loop (no `resume`, no `screen` refs, no `suggestions`) for the
 * commonest drift case.
 *
 * CI previously missed this because every existing divergence-shape test
 * (`session-replay-target-verification-runtime.test.ts`,
 * `session-replay-runtime-failure-response.test.ts`) drives the failure
 * through a RETURNED `{ok:false}` `invoke` response, which was never broken —
 * only a THROWN dispatch failure regressed. These tests mock `invoke` to
 * throw, matching the real production shape (`resolution.ts` throws
 * `AppError('COMMAND_FAILED', ..., { hint: selectorFailureHint(...) })` on a
 * zero-match selector) instead of returning it.
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
import { AppError } from '../../../kernel/errors.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import {
  bottomTabsRealCaptureFixture,
  recordArticleEvidence,
} from './session-replay-target-classification-fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});

function setupSession(root: string): { sessionStore: SessionStore; sessionName: string } {
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return { sessionStore, sessionName };
}

function throwSelectorMiss(selector: string): never {
  // Mirrors the real dispatch throw site (resolution.ts): a raw
  // AppError('COMMAND_FAILED', ..., { hint: selectorFailureHint(...) })
  // surfaced when a selector matches zero nodes.
  throw new AppError('COMMAND_FAILED', `No element matched selector ${selector}`, {
    hint: 'Run snapshot -i ... or use find ...',
  });
}

function assertDivergenceShape(
  response: Awaited<ReturnType<typeof runReplayScriptFile>>,
  expectedResume: { allowed: boolean; from: number } = { allowed: true, from: 1 },
): {
  divergence: Record<string, unknown>;
  targetBinding: Record<string, unknown> | undefined;
} {
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('expected failure response');
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence).toBeDefined();
  expect(typeof divergence.kind).toBe('string');

  const resume = divergence.resume as { allowed: boolean; from?: number; planDigest?: string };
  expect(resume.allowed).toBe(expectedResume.allowed);
  expect(resume.from).toBe(expectedResume.from);
  expect(typeof resume.planDigest).toBe('string');
  expect((resume.planDigest ?? '').length).toBeGreaterThan(0);

  const screen = divergence.screen as { state: string; refs?: unknown[] };
  expect(screen.state).toBe('available');
  expect(Array.isArray(screen.refs)).toBe(true);
  expect((screen.refs ?? []).length).toBeGreaterThan(0);

  return { divergence, targetBinding: divergence.targetBinding as Record<string, unknown> };
}

test('(a) an ANNOTATED press whose dispatch throws a selector-miss yields REPLAY_DIVERGENCE, not COMMAND_FAILED', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-dispatch-miss-annotated-'),
  );
  const { sessionStore, sessionName } = setupSession(root);
  const evidence = recordArticleEvidence();
  const filePath = writeReplayFile(root, [
    `# agent-device:target-v1 ${JSON.stringify(evidence)}`,
    'click id="article"',
  ]);

  // Pre-action verification (and the post-failure divergence capture) both
  // see the recorded target still present and unique — verification passes
  // (verified:true, guard minted) — but the REAL dispatch call independently
  // throws a selector-miss (e.g. a downstream resolution path the daemon
  // tree capture does not share). This is exactly the scenario the fix must
  // still wrap: verification passing must not suppress a thrown dispatch
  // failure.
  mockDispatchCommand.mockResolvedValue({
    nodes: bottomTabsRealCaptureFixture(),
    truncated: false,
    backend: 'xctest',
  });

  const invoked: string[] = [];
  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req.command);
      throwSelectorMiss('id="article"');
    },
  });

  expect(invoked).toEqual(['click']);
  // The recorded evidence carries a real, non-empty ancestry (a nested tab
  // button) and the post-response capture still contains that same
  // container, so this action-failure divergence routes to `record-and-heal`
  // (ADR 0012 decision 6, R3's container-presence test) — not the `manual`
  // default. `resume.from` must therefore target `failedIndex + 1` (decision
  // 6, R2): since this is the plan's only (and last) step, that is `from: 2`
  // = actions.length + 1 — a legal EMPTY-TAIL resume (nothing left to run
  // after the agent performs the corrective press), not an error.
  const { divergence } = assertDivergenceShape(response, { allowed: true, from: 2 });
  // A thrown dispatch failure is a generic action-failure divergence — it is
  // NOT re-derived as a target-binding classification (that only happens
  // when verification's OWN pre-action check finds the mismatch).
  expect(divergence.kind).toBe('action-failure');
  expect(divergence.repairHint).toBe('record-and-heal');
  const cause = divergence.cause as { code: string; message: string };
  expect(cause.code).toBe('COMMAND_FAILED');
  expect(cause.message).toContain('No element matched selector');
});

test('(b) an UNANNOTATED press whose dispatch throws a selector-miss yields REPLAY_DIVERGENCE, not COMMAND_FAILED', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-dispatch-miss-unannotated-'),
  );
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, ['click label="Renamed Button"']);

  // No target-v1 annotation: `verifyReplayActionTarget` returns
  // `{verified: true}` immediately and dispatch proceeds straight to
  // `invoke`, which throws for the drifted label.
  mockDispatchCommand.mockResolvedValue({
    nodes: bottomTabsRealCaptureFixture(),
    truncated: false,
    backend: 'xctest',
  });

  const invoked: string[] = [];
  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req.command);
      throwSelectorMiss('label="Renamed Button"');
    },
  });

  expect(invoked).toEqual(['click']);
  const { divergence } = assertDivergenceShape(response);
  expect(divergence.kind).toBe('action-failure');
  const cause = divergence.cause as { code: string; message: string };
  expect(cause.code).toBe('COMMAND_FAILED');
});

test('(c) a fill selector-miss thrown at dispatch yields REPLAY_DIVERGENCE, not COMMAND_FAILED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-dispatch-miss-fill-'));
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, [`fill 'label="Email"' "someone@example.com"`]);

  mockDispatchCommand.mockResolvedValue({
    nodes: bottomTabsRealCaptureFixture(),
    truncated: false,
    backend: 'xctest',
  });

  const invoked: string[] = [];
  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req.command);
      throwSelectorMiss('label="Email"');
    },
  });

  expect(invoked).toEqual(['fill']);
  const { divergence } = assertDivergenceShape(response);
  expect(divergence.kind).toBe('action-failure');
  const cause = divergence.cause as { code: string; message: string };
  expect(cause.code).toBe('COMMAND_FAILED');
  // The fill text itself must never leak into the divergence.
  expect(JSON.stringify(divergence)).not.toContain('someone@example.com');
});

test('(d) a thrown NON-AppError at dispatch propagates as an internal error, not REPLAY_DIVERGENCE', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-dispatch-miss-nonapperror-'),
  );
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, ['click label="Renamed Button"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: bottomTabsRealCaptureFixture(),
    truncated: false,
    backend: 'xctest',
  });

  const invoked: string[] = [];
  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req.command);
      // A programmer bug (unrelated to selector resolution), not an expected
      // dispatch failure — must NOT be coerced into a repairable divergence.
      throw new TypeError('boom');
    },
  });

  expect(invoked).toEqual(['click']);
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('expected failure response');
  expect(response.error.code).not.toBe('REPLAY_DIVERGENCE');
  expect(response.error.code).toBe('UNKNOWN');
  expect(response.error.message).toContain('boom');
});

test('(e) a thrown AppError with retriable/supportedOn preserves them at the top level of the divergence response', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-dispatch-miss-retriable-'),
  );
  const { sessionStore, sessionName } = setupSession(root);
  const filePath = writeReplayFile(root, ['click label="Renamed Button"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: bottomTabsRealCaptureFixture(),
    truncated: false,
    backend: 'xctest',
  });

  const invoked: string[] = [];
  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req.command);
      throw new AppError('COMMAND_FAILED', 'device busy mid-gesture', {
        retriable: true,
        supportedOn: 'ios',
      });
    },
  });

  expect(invoked).toEqual(['click']);
  const { divergence } = assertDivergenceShape(response);
  expect(divergence.kind).toBe('action-failure');
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('expected failure response');
  // Normalized via normalizeError: hoisted onto the top-level error, not
  // buried in divergence.cause (which only carries code/message/hint).
  expect(response.error.retriable).toBe(true);
  expect(response.error.supportedOn).toBe('ios');
});
