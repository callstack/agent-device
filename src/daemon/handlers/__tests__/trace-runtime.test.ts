import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, SessionState } from '../../types.ts';
import { handleTraceCommand } from '../trace-runtime.ts';

function fixture() {
  const root = mkdtempForTestSync('agent-device-trace-runtime-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session: SessionState = {
    name: 'trace-session',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'emulator',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
  sessionStore.set(session.name, session);
  return { root, session, sessionStore };
}

function request(positionals: string[], clientOutPath?: string): DaemonRequest {
  return {
    token: 'token',
    session: 'trace-session',
    command: 'trace',
    positionals,
    flags: {},
    ...(clientOutPath ? { meta: { clientArtifactPaths: { outPath: clientOutPath } } } : {}),
  };
}

test('starts and stops one trace through the session-owned trace slot', () => {
  const { session, sessionStore } = fixture();
  const start = handleTraceCommand({
    req: request(['start']),
    sessionName: session.name,
    sessionStore,
  });
  const startedPath = session.trace?.outPath;
  expect(startedPath).toMatch(/trace-session-.*\.trace\.log$/);
  expect(start).toMatchObject({ ok: true, data: { trace: 'started', outPath: startedPath } });

  const stop = handleTraceCommand({
    req: request(['stop']),
    sessionName: session.name,
    sessionStore,
  });
  expect(stop).toMatchObject({ ok: true, data: { trace: 'stopped' } });
  expect(session.trace).toBeUndefined();
});

test('relocates trace output and projects the client artifact path', () => {
  const { root, session, sessionStore } = fixture();
  const original = path.join(root, 'original.trace');
  const relocated = path.join(root, 'relocated.trace');
  const client = '/client/trace.json';
  handleTraceCommand({
    req: request(['start', original]),
    sessionName: session.name,
    sessionStore,
  });

  const stop = handleTraceCommand({
    req: request(['stop', relocated], client),
    sessionName: session.name,
    sessionStore,
  });
  expect(fs.existsSync(original)).toBe(false);
  expect(fs.existsSync(relocated)).toBe(true);
  expect(stop).toMatchObject({
    ok: true,
    data: {
      outPath: relocated,
      artifacts: [{ path: relocated, localPath: client, fileName: 'trace.json' }],
    },
  });
});

test('rejects invalid actions, missing sessions, and incoherent lifecycle transitions', () => {
  const { session, sessionStore } = fixture();
  expect(
    handleTraceCommand({ req: request(['pause']), sessionName: session.name, sessionStore }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  expect(
    handleTraceCommand({ req: request(['start']), sessionName: 'missing', sessionStore }),
  ).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND' } });
  expect(
    handleTraceCommand({ req: request(['stop']), sessionName: session.name, sessionStore }),
  ).toMatchObject({ ok: false, error: { message: 'no active trace' } });

  handleTraceCommand({ req: request(['start']), sessionName: session.name, sessionStore });
  expect(
    handleTraceCommand({ req: request(['start']), sessionName: session.name, sessionStore }),
  ).toMatchObject({ ok: false, error: { message: 'trace already in progress' } });
});
