import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest } from '../../types.ts';
import {
  buildRetriableRepairCloseFailureResponse,
  commitRepairScriptBeforeClose,
  finalizeOrdinaryCloseScript,
} from '../session-close-script.ts';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-close-script-'));
  roots.push(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeIosSession(name, { appBundleId: 'com.example.app' });
  sessionStore.set(name, session);
  const req: DaemonRequest = {
    token: 'token',
    session: name,
    command: 'close',
    positionals: [],
    flags: {},
  };
  return { req, session, sessionStore };
}

test('failed repair publication removes only its synthetic close before retry', () => {
  const { req, session, sessionStore } = setup('repair');
  session.saveScriptBoundary = 0;
  session.saveScriptComplete = true;
  session.recordSession = true;
  const failure = new AppError('COMMAND_FAILED', 'publish failed');
  vi.spyOn(sessionStore, 'writeSessionLog').mockReturnValue({ written: false, error: failure });

  expect(commitRepairScriptBeforeClose(sessionStore, session, req)).toEqual({
    kind: 'failed',
    error: failure,
  });
  expect(session.actions).toEqual([]);
});

test('repair close failure keeps normalized metadata and is explicitly retriable', () => {
  const { session } = setup('repair-error');
  session.saveScriptPath = '/tmp/repaired.ad';
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
  const { req, session, sessionStore } = setup('ordinary');
  const failure = new AppError('COMMAND_FAILED', 'target exists', {
    reason: 'target-exists',
    hint: 'Retry close.',
  });
  vi.spyOn(sessionStore, 'writeSessionLog').mockImplementation(() => {
    throw failure;
  });

  const result = finalizeOrdinaryCloseScript({
    req: { ...req, flags: { saveScript: true } },
    session,
    sessionStore,
    platformCloseError: undefined,
  });

  expect(session.actions.map(({ command }) => command)).toEqual(['close']);
  expect(result).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'The session was closed, but its script was not saved: target exists',
    details: {
      reason: 'target-exists',
      retriable: false,
    },
  });
});
