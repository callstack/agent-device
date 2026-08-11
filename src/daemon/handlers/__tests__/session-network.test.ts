import path from 'node:path';
import { expect, test } from 'vitest';
import { handleSessionCommands } from './session-command-harness.ts';
import { createNetworkRuntime, emptyAppLogResult } from './network-runtime-harness.ts';
import { makeSession, makeSessionStore, noopInvoke } from './session-test-harness.ts';

test('network requires an active session before requesting a runtime binding', async () => {
  const sessionStore = makeSessionStore();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'missing',
      command: 'network',
      positionals: ['dump'],
      flags: {},
    },
    sessionName: 'missing',
    logPath: path.join(sessionStore.resolveSessionDir('missing'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toEqual({
    ok: false,
    error: { code: 'SESSION_NOT_FOUND', message: 'network requires an active session' },
  });
});

test('network validates the legacy limit after runtime-fact admission', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('android-network', {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  });
  sessionStore.set(session.name, session);
  const runtime = createNetworkRuntime(session.device, async (input) =>
    emptyAppLogResult('android', input),
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: session.name,
      command: 'network',
      positionals: ['dump', '0'],
      flags: {},
    },
    sessionName: session.name,
    logPath: path.join(sessionStore.resolveSessionDir(session.name), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    invoke: noopInvoke,
  });

  expect(response).toEqual({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'network dump limit must be an integer in range 1..200',
    },
  });
  expect(runtime.uses).toEqual([{ required: [], preferred: ['networkDump'] }]);
  expect(runtime.networkDump).not.toHaveBeenCalled();
});
