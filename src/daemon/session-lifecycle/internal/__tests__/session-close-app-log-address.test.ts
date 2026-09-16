import { beforeEach, expect, test, vi } from 'vitest';
import type { AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { appLogResourceStore } from '../../../app-log-resource-store.ts';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

const {
  handleSessionCommands,
  localRuntimeOwner,
  makeSession,
  makeSessionStore,
  noopInvoke,
  path,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

// An implicitly cwd-scoped session is *named* `default` but *stored* under
// `cwd:<hash>:default` (see `SessionRef`). Its durable app-log record lives in
// the address's directory, so teardown must address it by `sessionName`, not
// `session.name`. When it used `session.name`, `close` reported
// "App-log resource record is missing", left the record `open`/`active`, and
// leaked the `log stream` child; the next `logs start` on that device then
// failed with "has not reached a confirmed terminal state".
test('close stops the app log of a cwd-scoped session whose name differs from its store address', async () => {
  const sessionStore = makeSessionStore();
  const sessionAddress = 'cwd:0f803c4542a46e92:default';
  const sessionName = 'default';
  const device: SessionState['device'] = {
    platform: 'apple',
    appleOs: 'ios',
    id: '9105AAA0-3184-40BC-A9FC-46634C90DFFB',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
  };
  const sessionDir = sessionStore.resolveSessionDir(sessionAddress);
  const outputPath = path.join(sessionDir, 'app.log');
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);
  const handle: AppLogLiveHandle = {
    inspect: () => ({ backend: 'ios-simulator', state: 'active', startedAt: Date.now() - 1000 }),
    finish: async () => ({
      status: 'completed' as const,
      result: { backend: 'ios-simulator', outputPath, completedAt: Date.now() },
    }),
    forceCleanup,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: sessionAddress,
    device: { id: device.id, family: 'apple', appleOs: 'ios', kind: 'simulator', target: 'mobile' },
    owner: localRuntimeOwner('apple'),
    fence: { token: 'app-log-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: {
      version: 1,
      body: {
        transport: 'apple-log-stream',
        backend: 'ios-simulator',
        outputPath,
        pidPath: path.join(sessionDir, 'app-log.pid'),
      },
    },
    metadata: { phase: 'active' },
  });
  const session: SessionState = {
    ...makeSession(sessionName, device),
    appBundleId: 'com.apple.Preferences',
    appLog: { handle, envelope },
  };
  sessionStore.set(sessionAddress, session);
  const resourcePath = appLogResourceStore.resolvePath(sessionDir);
  appLogResourceStore.write(resourcePath, envelope);
  // The record must NOT exist under the bare name: that directory is a different session.
  expect(
    appLogResourceStore.read(
      appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
    ).status,
  ).toBe('missing');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionAddress,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName: sessionAddress,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(forceCleanup).toHaveBeenCalledOnce();
  const record = appLogResourceStore.read(resourcePath);
  expect(record.status).toBe('decoded');
  if (record.status === 'decoded') expect(record.envelope.lifecycle).toBe('completed');
  expect(sessionStore.get(sessionAddress)).toBeUndefined();
});
