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
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});
test('resume skips steps 1..from-1 without invoking them and executes only from the reported step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-skip-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, [
    'open "Demo"',
    'click label="Continue"',
    'click label="Save"',
  ]);

  // First attempt: step 3 fails, capturing a real resume report.
  const firstAttempt = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'click' && req.positionals?.[0] === 'label="Save"') {
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'not hittable' } };
      }
      return { ok: true, data: {} };
    },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.resume.allowed).toBe(true);
  expect(divergence.resume.from).toBe(3);

  // Second attempt: repair app state, resume at the reported step. Steps 1-2
  // must never be invoked — the mock throws if they are.
  const invokedCommands: string[] = [];
  const resumedAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayFrom: divergence.resume.from, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invokedCommands.push(`${req.command} ${req.positionals?.[0] ?? ''}`.trim());
      if (req.command === 'open' || req.positionals?.[0] === 'label="Continue"') {
        throw new Error('resume must not re-invoke a skipped step');
      }
      return { ok: true, data: {} };
    },
  });

  expect(resumedAttempt.ok).toBe(true);
  if (!resumedAttempt.ok) return;
  expect(invokedCommands).toEqual(['click label="Save"']);
  const data = resumedAttempt.data as { replayed: number };
  expect(data.replayed).toBe(1);
});

test('resume requires both --from and --plan-digest together', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-pair-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const fromOnly = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayFrom: 2 } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute before the flag-pair preflight');
    },
  });
  expect(fromOnly.ok).toBe(false);
  if (!fromOnly.ok) expect(fromOnly.error.code).toBe('INVALID_ARGS');

  const digestOnly = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayPlanDigest: 'deadbeef' } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute before the flag-pair preflight');
    },
  });
  expect(digestOnly.ok).toBe(false);
  if (!digestOnly.ok) expect(digestOnly.error.code).toBe('INVALID_ARGS');
});

test('resume rejects an out-of-range --from before any action', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-range-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayFrom: 99, replayPlanDigest: 'deadbeef' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute an out-of-range resume');
    },
  });
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/out of range/);
});

test('resume rejects a stale --plan-digest after the script changed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-stale-digest-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const firstAttempt = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'click') {
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'not hittable' } };
      }
      return { ok: true, data: {} };
    },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string };
  };

  // Edit the script (an extra step) before resuming: the digest must no
  // longer match.
  fs.writeFileSync(filePath, 'open "Demo"\nclick "Extra"\nclick "Save"\n');

  const resumedAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayFrom: divergence.resume.from, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute on a plan-digest mismatch');
    },
  });
  expect(resumedAttempt.ok).toBe(false);
  if (resumedAttempt.ok) return;
  expect(resumedAttempt.error.code).toBe('INVALID_ARGS');
  expect(resumedAttempt.error.message).toMatch(/plan digest/);
});

test('resume rejects a digest from a different effective platform or target before any action', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-resume-effective-target-'),
  );
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, [
    'context platform=android target=tv',
    'open "Demo"',
    'click "Save"',
  ]);
  const executionFlags = { platform: 'ios' as const, target: 'mobile' as const };

  const firstAttempt = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: executionFlags }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) =>
      req.command === 'click'
        ? { ok: false, error: { code: 'COMMAND_FAILED', message: 'not hittable' } }
        : { ok: true, data: {} },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { from: number; planDigest: string };
  };

  for (const changedExecutionFlags of [
    { ...executionFlags, target: 'desktop' as const },
    { ...executionFlags, platform: 'android' as const },
  ]) {
    const resumedAttempt = await runReplayScriptFile({
      req: baseReq({
        positionals: [filePath],
        flags: {
          ...changedExecutionFlags,
          replayFrom: divergence.resume.from,
          replayPlanDigest: divergence.resume.planDigest,
        },
      }),
      sessionName,
      logPath: path.join(root, 'daemon.log'),
      sessionStore,
      invoke: async () => {
        throw new Error('must not execute when effective replay target changed');
      },
    });

    expect(resumedAttempt.ok).toBe(false);
    if (!resumedAttempt.ok) {
      expect(resumedAttempt.error.code).toBe('INVALID_ARGS');
      expect(resumedAttempt.error.message).toMatch(/plan digest/);
    }
  }
});
test('resume rejects resuming past a retry-wrapped step in the skipped range', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-control-flow-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const mainPath = path.join(root, 'main.yaml');
  fs.writeFileSync(
    mainPath,
    [
      'appId: com.callstack.agentdevicelab',
      '---',
      '- retry:',
      '    maxRetries: 1',
      '    commands:',
      '      - back',
      '- back',
      '',
    ].join('\n'),
  );

  // `back` has no Maestro-specific runtime handling, so it reaches `invoke`
  // directly — the retry block's nested `back` (1st call) succeeds; the
  // top-level step-2 `back` (2nd call) fails.
  let backCalls = 0;
  const firstAttempt = await runReplayScriptFile({
    req: baseReq({ positionals: [mainPath], flags: { replayBackend: 'maestro' } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command !== 'back') return { ok: true, data: {} };
      backCalls += 1;
      if (backCalls === 1) return { ok: true, data: {} };
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'back failed' } };
    },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string; reason?: string };
  };
  // Step 2 (tapOn: Save) is the reported failure; resuming there means
  // skipping step 1, the retry block.
  expect(divergence.resume.from).toBe(2);
  expect(divergence.resume.allowed).toBe(false);
  expect(divergence.resume.reason).toMatch(/control flow/);

  const resumedAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [mainPath],
      flags: {
        replayBackend: 'maestro',
        replayFrom: divergence.resume.from,
        replayPlanDigest: divergence.resume.planDigest,
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute a resume the preflight rejected');
    },
  });
  expect(resumedAttempt.ok).toBe(false);
  if (resumedAttempt.ok) return;
  expect(resumedAttempt.error.code).toBe('INVALID_ARGS');
  expect(resumedAttempt.error.message).toMatch(/control flow/);
});
