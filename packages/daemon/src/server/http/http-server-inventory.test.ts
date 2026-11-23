import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import * as requestExecution from '../request-execution-scope.ts';
import { deferred, startDaemon, TENANT } from './http-server-session-lease-touch.fixtures.ts';

test('devices returns inventory when close retires the admitted session during preparation', async (context) => {
  if (await skipWhenLoopbackUnavailable(context)) return;
  const daemon = await startDaemon();
  const { sessionName, sessionStore, send, requestTeardown, leaseRegistry } = daemon;
  const session = makeIosAppSession(sessionName, { sessionScope: { kind: 'tenant', id: TENANT } });
  const original = sessionStore.publish(sessionName, session);
  const teardownEntered = deferred();
  const finishClose = deferred();
  requestTeardown.stopSnapshotHelper.mockImplementationOnce(async () => {
    teardownEntered.resolve();
    await finishClose.promise;
  });
  const close = send(
    'close',
    [],
    { sessionIsolation: 'none', tenantId: undefined },
    {
      session: sessionName,
    },
  );
  try {
    await Promise.race([
      teardownEntered.promise,
      close.then((response) => {
        throw new Error(`Close finished before teardown: ${JSON.stringify(response)}`);
      }),
    ]);
    const prepare = requestExecution.prepareLockedRequestScope;
    vi.spyOn(requestExecution, 'prepareLockedRequestScope').mockImplementation(async (params) => {
      const { scope } = params;
      if (scope.command === 'devices') {
        expect(scope.admittedRef?.lifetime).toBe(original.lifetime);
        const tryLock = scope.tryRunUnderSessionLock;
        scope.tryRunUnderSessionLock = async (...args) => {
          const locks = requestExecution.getLeaseRegistryExecutionLocks(leaseRegistry);
          expect(locks.has(`session:${sessionName}`)).toBe(true);
          const probe = tryLock(...args);
          finishClose.resolve();
          await Promise.all([probe, close]);
        };
      }
      return await prepare(params);
    });

    const inventory = await send('devices', [], {});
    expect(inventory.result, JSON.stringify(inventory)).toMatchObject({
      ok: true,
      data: { devices: [expect.objectContaining({ id: 'sim-1' })] },
    });
    expect((await close).result?.ok).toBe(true);
    expect(sessionStore.lookup(sessionName)).toBeUndefined();
  } finally {
    finishClose.resolve();
    vi.restoreAllMocks();
    await Promise.allSettled([close]);
    await daemon.close();
  }
});
