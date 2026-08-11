import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { appLogDurableResource } from '../app-log-session-resource.ts';

test('generic recovery terminalizes missing native authority through one exact control', async () => {
  const sessionStore = makeSessionStore('durable-capture-recovery-');
  const sessionsDir = path.dirname(sessionStore.resolveSessionDir('session'));
  const resourcePath = appLogDurableResource.store.resolvePath(
    sessionStore.resolveSessionDir('session'),
  );
  appLogDurableResource.store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: 'session',
      device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  const dispose = vi.fn(async () => {});

  await expect(
    appLogDurableResource.recoverAll({
      sessionsDir,
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      acquireControl: async () => ({
        reattach: async () => ({ status: 'missing' }),
        cleanup: async () => ({ status: 'already-missing' }),
        [Symbol.asyncDispose]: dispose,
      }),
    }),
  ).resolves.toEqual({ scanned: 1, recovered: 1, retained: 0 });
  expect(dispose).toHaveBeenCalledOnce();
  expect(appLogDurableResource.store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'completed',
      metadata: { phase: 'completed', recoveryStatus: 'already-missing' },
    },
  });
});
