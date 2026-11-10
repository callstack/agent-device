import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  authoringPublication,
  makeIosSession,
  makeRepairCompleteSession,
} from '../../../../__tests__/support/session-factories.ts';
import { SessionStore } from '../../../../core/session-store.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import {
  buildRetriableRepairCloseFailureResponse,
  commitRepairScriptBeforeClose,
  finalizeOrdinaryCloseScript,
} from '../session-close-script.ts';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { flushSessionEventLogWrites } from '@agent-device/session-journal/session-event-log';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  // Every close path here records an action, and `SessionStore.recordAction` QUEUES the event-log
  // append rather than writing it (`queueEventLogWrite`). Removing the root while one is still
  // pending lets the write recreate `<root>/sessions/<name>/` mid-walk, and `rmSync` fails
  // ENOTEMPTY — observed on CI under parallel load, where the queued write lands late enough.
  await flushSessionEventLogWrites();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(name: string, session = makeIosSession(name, { appBundleId: 'com.example.app' })) {
  const root = mkdtempForTestSync('agent-device-session-close-script-');
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const sessionStore = new SessionStore(sessionsDir, createLiveTestHostEnvironment());
  const ref = sessionStore.publish(name, session);
  const req: DaemonRequest = {
    token: 'token',
    session: name,
    command: 'close',
    positionals: [],
    flags: {},
  };
  return { req, ref, session, sessionStore, sessionsDir };
}

test('failed repair publication removes only its synthetic close before retry', () => {
  const { req, ref, session, sessionStore } = setup(
    'repair',
    makeRepairCompleteSession('repair', { appBundleId: 'com.example.app' }),
  );
  const failure = new AppError('COMMAND_FAILED', 'publish failed');
  vi.spyOn(sessionStore, 'writeSessionLog').mockReturnValue({ written: false, error: failure });

  expect(commitRepairScriptBeforeClose(sessionStore, ref, req)).toEqual({
    kind: 'failed',
    error: failure,
  });
  expect(session.actions).toEqual([]);
});

test('repair close failure keeps normalized metadata and is explicitly retriable', () => {
  const { session } = setup('repair-error');
  session.scriptPublication = {
    kind: 'repair',
    status: 'armed',
    target: { kind: 'explicit', path: '/tmp/repaired.ad', force: false },
    boundary: 0,
  };
  const failure = new AppError('COMMAND_FAILED', 'publish failed', {
    reason: 'target-exists',
    hint: 'Choose another path.',
    logPath: '/tmp/daemon.log',
  });

  expect(buildRetriableRepairCloseFailureResponse(session, failure)).toEqual({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'publish failed',
      hint: 'Choose another path.',
      logPath: '/tmp/daemon.log',
      details: {
        reason: 'target-exists',
        session: 'repair-error',
        savedScript: '/tmp/repaired.ad',
      },
      retriable: true,
    },
  });
});

test('ordinary publication failure retains its close action after making the error non-retriable', () => {
  const { req, ref, session, sessionStore } = setup('ordinary');
  const failure = new AppError('COMMAND_FAILED', 'target exists', {
    reason: 'target-exists',
    hint: 'Retry close.',
  });
  vi.spyOn(sessionStore, 'writeSessionLog').mockReturnValue({ written: false, error: failure });

  const result = finalizeOrdinaryCloseScript({
    req: { ...req, flags: { saveScript: true } },
    ref,
    sessionStore,
    platformCloseError: undefined,
  });

  expect(session.actions.map(({ command }) => command)).toEqual(['close']);
  expect(result).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'The session was closed, but its script was not saved: target exists',
    details: {
      reason: 'target-exists',
      hint: 'Remove the existing target (or pass --force/--overwrite), then re-record with open --save-script.',
      retriable: false,
    },
  });
});

// --- #1533: a bare `close` after an aborted --save-script re-arm publishes nothing ---
//
// `close --save-script` on this session is refused by `assertTerminalRecordingCloseAllowed`
// with "Retry with plain close; it will tear down the session without writing." These pin
// that promise: the plain-close teardown path must write nothing.

test('#1533: bare close on an aborted authoring session writes no script', () => {
  const { req, ref, sessionStore, sessionsDir } = setup(
    'aborted',
    makeIosSession('aborted', {
      appBundleId: 'com.example.app',
      // Post-`abortAuthoringOnSecondOpen`: terminal, and therefore not recording.
      scriptPublication: authoringPublication('aborted'),
      actions: [{ ts: 1, command: 'click', positionals: ['id="save"'], flags: {} }],
    }),
  );

  expect(
    finalizeOrdinaryCloseScript({
      req,
      ref,
      sessionStore,
      platformCloseError: undefined,
    }),
  ).toBeUndefined();

  expect(sessionStore.get('aborted')?.scriptPublication).toEqual(authoringPublication('aborted'));
  expect(fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []).toEqual([]);
});

test('#1533: an ordinary armed authoring session still publishes on bare close', () => {
  const { req, ref, sessionStore, sessionsDir } = setup(
    'armed',
    makeIosSession('armed', {
      appBundleId: 'com.example.app',
      scriptPublication: authoringPublication('armed'),
      actions: [{ ts: 1, command: 'click', positionals: ['id="save"'], flags: {} }],
    }),
  );

  expect(
    finalizeOrdinaryCloseScript({
      req,
      ref,
      sessionStore,
      platformCloseError: undefined,
    }),
  ).toBeUndefined();

  expect(fs.readdirSync(sessionsDir)).toHaveLength(1);
});

test('ordinary close reports a filesystem failure of its script write instead of a quiet success', () => {
  const root = mkdtempForTestSync('agent-device-session-close-script-fs-');
  roots.push(root);
  // A regular file where the target directory must be: publishing into it fails with ENOTDIR.
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, '');
  const targetPath = path.join(blocker, 'flow.ad');
  const { req, ref, sessionStore } = setup(
    'fs-failure',
    makeIosSession('fs-failure', {
      appBundleId: 'com.example.app',
      scriptPublication: authoringPublication('armed', { path: targetPath }),
      actions: [{ ts: 1, command: 'click', positionals: ['id="save"'], flags: {} }],
    }),
  );

  const result = finalizeOrdinaryCloseScript({
    req,
    ref,
    sessionStore,
    platformCloseError: undefined,
  });

  expect(result).toBeInstanceOf(AppError);
  expect(result).toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'script_write_failed',
      path: targetPath,
      hint: 'Check the target path and its permissions, then re-record with open --save-script.',
      retriable: false,
    },
  });
  expect(result?.message).toContain('The session was closed, but its script was not saved');
  expect(result?.message).toContain(targetPath);
});
