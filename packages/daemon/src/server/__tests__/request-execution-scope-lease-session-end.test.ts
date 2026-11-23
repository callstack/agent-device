import {
  deviceClaimFilePath,
  mkdtempForTestSync,
  bindTestCommandHost,
} from '@agent-device/test-kit';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { authoringPublication, makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/support/device-claim-store.ts';
import { acquireDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { existingSessionExecutionLockKeys } from '../request-binding.ts';
import { withRequestExecutionLockKeys } from '../request-execution-locks.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type { PlatformResourceCleanup } from '../../core/platform-resource-cleanup.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import type { SessionTeardown } from '../../sessions/lease-lifecycle.ts';
import { settleExpiredSession } from '../../sessions/session-teardown.ts';
import { createLeaseSessionEnd, EXPIRY_TRANSITIONS } from '../lease-session-end.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

bindTestCommandHost();

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

const claimStores = isolatedDeviceClaimStores('agent-device-lease-end-claims-');

async function publishLeasedSession(
  sessionStore: SessionStore,
  name: string,
  leaseId: string,
): Promise<string> {
  const { stateDir } = claimStores();
  const session = makeIosSession(name, {
    lease: {
      backend: 'ios-simulator',
      leaseId,
      tenantId: 'tenant-a',
      runId: 'run-1',
      deviceKey: 'ios:simulator:fixture',
    },
  });
  const acquired = await acquireDeviceClaim({
    env: process.env,
    device: session.device,
    session: name,
    workspace: stateDir,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (acquired.status !== 'acquired') throw new Error('expected an acquired claim');
  sessionStore.publish(name, { ...session, deviceClaim: acquired.ownership });
  return deviceClaimFilePath(acquired.ownership.deviceKey);
}

function holdSessionLocks(
  executionLocks: Map<string, Promise<unknown>>,
  sessionStore: SessionStore,
  name: string,
): { finish: () => void; held: Promise<void> } {
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const held = withRequestExecutionLockKeys(
    executionLocks,
    existingSessionExecutionLockKeys(name, sessionStore.get(name)!.device.id),
    async () => await running,
  );
  return { finish, held };
}

function leaseSessionEnd(
  sessionStore: SessionStore,
  teardownSession: SessionTeardown,
  cleanupSessionlessExecutionHost: PlatformResourceCleanup['cleanupSessionlessExecutionHost'] = vi.fn(
    async () => {},
  ),
) {
  const executionLocks = new Map<string, Promise<unknown>>();
  return {
    executionLocks,
    ender: createLeaseSessionEnd({
      env: process.env,
      sessionStore,
      executionLocks,
      teardownSession,
      cleanupSessionlessExecutionHost,
      withinDiagnosticsScope: (run) => run(),
    }),
  };
}

const settle = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve));

function retainExecutionHost(sessionStore: SessionStore, name = 'leased', leaseId = 'lease-1') {
  const ref = sessionStore.publish(
    name,
    makeIosSession(name, {
      lease: { backend: 'ios-simulator', leaseId, tenantId: 'tenant-a', runId: 'run-1' },
    }),
  );
  sessionStore.retire(ref, { retainExecutionHost: true });
  return ref;
}

test.each(['LEASE_RELEASED', 'LEASE_EXPIRED'] as const)(
  '%s stops a retained host after its session has retired',
  async (reason) => {
    const sessionStore = makeSessionStore();
    const ref = retainExecutionHost(sessionStore);
    const cleanup = vi.fn(async () => {});
    const teardown = vi.fn(async () => {});
    const { ender } = leaseSessionEnd(sessionStore, teardown, cleanup);

    await ender.end('lease-1', reason);

    expect(teardown).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(ref.session.device);
    expect(sessionStore.listRetainedExecutionHosts('lease-1')).toEqual([]);
  },
);

test('expiry waiting behind close cleans the host that close retains before retiring', async () => {
  const sessionStore = makeSessionStore();
  const ref = sessionStore.publish(
    'leased',
    makeIosSession('leased', {
      lease: { backend: 'ios-simulator', leaseId: 'lease-1', tenantId: 'tenant-a', runId: 'run-1' },
    }),
  );
  const cleanup = vi.fn(async () => {});
  const teardown = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, teardown, cleanup);
  const close = holdSessionLocks(executionLocks, sessionStore, 'leased');
  const ending = ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  expect(cleanup).not.toHaveBeenCalled();

  sessionStore.retire(ref, { retainExecutionHost: true });
  close.finish();
  await close.held;
  await ending;

  expect(teardown).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledExactlyOnceWith(ref.session.device);
  expect(sessionStore.listRetainedExecutionHosts('lease-1')).toEqual([]);
});

test.each([false, true])(
  'lease end preserves a replacement owner with retained=%s',
  async (retained) => {
    const sessionStore = makeSessionStore();
    const old = retainExecutionHost(sessionStore);
    const cleanup = vi.fn(async () => {});
    const { executionLocks, ender } = leaseSessionEnd(sessionStore, async () => {}, cleanup);
    let unlock!: () => void;
    const held = withRequestExecutionLockKeys(
      executionLocks,
      existingSessionExecutionLockKeys(old.address, old.session.device.id),
      async () =>
        await new Promise<void>((resolve) => {
          unlock = resolve;
        }),
    );
    await settle();
    const ending = ender.end('lease-1', 'LEASE_RELEASED');
    await settle();
    const replacement = sessionStore.publish(
      'replacement',
      makeIosSession('replacement', {
        lease: {
          backend: 'ios-simulator',
          leaseId: 'lease-2',
          tenantId: 'tenant-b',
          runId: 'run-2',
        },
      }),
    );
    if (retained) sessionStore.retire(replacement, { retainExecutionHost: true });
    unlock();
    await held;
    await ending;

    expect(cleanup).not.toHaveBeenCalled();
    expect(sessionStore.listRetainedExecutionHosts('lease-1')).toEqual([]);
    if (retained) expect(sessionStore.listRetainedExecutionHosts('lease-2')).toHaveLength(1);
    else expect(sessionStore.resolveCurrent(replacement)).toBeDefined();
  },
);

test('release ends a same-lease reopen published at a new address while cleanup waits for its device', async () => {
  const sessionStore = makeSessionStore();
  const old = retainExecutionHost(sessionStore);
  const cleanup = vi.fn(async () => {});
  const teardown = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, teardown, cleanup);
  let finishNativeOpen!: () => void;
  const nativeOpen = new Promise<void>((resolve) => {
    finishNativeOpen = resolve;
  });
  const reopening = withRequestExecutionLockKeys(
    executionLocks,
    existingSessionExecutionLockKeys('reopened', old.session.device.id),
    async () => {
      await nativeOpen;
      sessionStore.publish('reopened', makeIosSession('reopened', { lease: old.session.lease }));
    },
  );
  await settle();
  const ending = ender.end('lease-1', 'LEASE_RELEASED');
  await settle();
  expect(teardown).not.toHaveBeenCalled();
  finishNativeOpen();
  await reopening;
  await ending;

  expect(cleanup).not.toHaveBeenCalled();
  expect(teardown).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ address: 'reopened' }),
  );
  expect(sessionStore.get('reopened')).toBeUndefined();
  expect(sessionStore.listRetainedExecutionHosts('lease-1')).toEqual([]);
});

test('failed retained-host cleanup stays owned and throttles retries without another release request', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  try {
    const sessionStore = makeSessionStore();
    retainExecutionHost(sessionStore);
    const cleanup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('device unreachable'))
      .mockRejectedValueOnce(new Error('device still unreachable'));
    const { ender } = leaseSessionEnd(sessionStore, async () => {}, cleanup);

    await ender.end('lease-1', 'LEASE_RELEASED');
    expect(sessionStore.listRetainedExecutionHosts('lease-1')).toHaveLength(1);
    for (let elapsed = 1_000; elapsed < 10_000; elapsed += 1_000) {
      now.mockReturnValue(elapsed);
      await ender.retryPending();
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
    now.mockReturnValue(10_000);
    await ender.retryPending();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(sessionStore.listRetainedExecutionHosts('lease-1')).toHaveLength(1);
    now.mockReturnValue(19_999);
    await ender.retryPending();
    expect(cleanup).toHaveBeenCalledTimes(2);
    now.mockReturnValue(20_000);
    await ender.retryPending();
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(sessionStore.listRetainedExecutionHosts('lease-1')).toEqual([]);
    now.mockReturnValue(30_000);
    await ender.retryPending();
    expect(cleanup).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
  }
});

test('cancel preserves a retained host queued for cleanup for daemon shutdown', async () => {
  const sessionStore = makeSessionStore();
  const ref = retainExecutionHost(sessionStore);
  const cleanup = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, async () => {}, cleanup);
  let unlock!: () => void;
  const held = withRequestExecutionLockKeys(
    executionLocks,
    existingSessionExecutionLockKeys(ref.address, ref.session.device.id),
    async () =>
      await new Promise<void>((resolve) => {
        unlock = resolve;
      }),
  );
  await settle();
  const ending = ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  ender.cancel();
  unlock();
  await held;
  await ending;
  await ender.drain();
  await ender.retryPending();

  expect(cleanup).not.toHaveBeenCalled();
  expect(sessionStore.listRetainedExecutionHosts('lease-1')).toHaveLength(1);
});

test('retry does not queue duplicate cleanup and shutdown drains a running retained-host stop', async () => {
  const sessionStore = makeSessionStore();
  retainExecutionHost(sessionStore);
  let finish!: () => void;
  const cleanup = vi.fn(
    async () =>
      await new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { ender } = leaseSessionEnd(sessionStore, async () => {}, cleanup);
  const ending = ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  await ender.retryPending();
  expect(cleanup).toHaveBeenCalledTimes(1);
  ender.cancel();
  let drained = false;
  const drain = ender.drain().then(() => {
    drained = true;
  });
  await settle();
  expect(drained).toBe(false);
  finish();
  await ending;
  await drain;
  expect(sessionStore.listRetainedExecutionHosts('lease-1')).toEqual([]);
});

test('a request holding the device lock can end its lease ahead of a queued background end', async () => {
  const sessionStore = makeSessionStore();
  const ref = retainExecutionHost(sessionStore);
  const cleanup = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, async () => {}, cleanup);
  let release!: () => void;
  const continueRequest = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = withRequestExecutionLockKeys(
    executionLocks,
    existingSessionExecutionLockKeys(ref.address, ref.session.device.id),
    async () => {
      await continueRequest;
      await ender.end('lease-1', 'LEASE_RELEASED');
    },
  );
  await settle();
  const expiry = ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  release();
  await request;
  await expiry;

  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(sessionStore.listRetainedExecutionHosts('lease-1')).toEqual([]);
});

test('end publishes the recorded script of the session it ends', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-script-');
  await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  const scriptPath = path.join(mkdtempForTestSync('agent-device-lease-end-ad-'), 'flow.ad');
  sessionStore.update(sessionStore.lookup('leased')!, {
    scriptPublication: authoringPublication('armed', { path: scriptPath }),
    actions: [{ ts: 1, command: 'click', positionals: ['id="recorded-step"'], flags: {} }],
  });

  await leaseSessionEnd(sessionStore, async () => {}).ender.end('lease-1', 'LEASE_EXPIRED');

  expect(sessionStore.get('leased')).toBeUndefined();
  expect(fs.readFileSync(scriptPath, 'utf8')).toMatch(/recorded-step/);
});

test.each(['LEASE_RELEASED', 'PROVIDER_INSTANCE_ENDED', 'LEASE_EXPIRED'] as const)(
  '%s logs and tears down its session and clears its device claim',
  async (reason) => {
    vi.mocked(emitDiagnostic).mockClear();
    const sessionStore = makeSessionStore('agent-device-lease-end-');
    const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');
    sessionStore.publish(
      'other',
      makeIosSession('other', {
        lease: {
          backend: 'ios-simulator',
          leaseId: 'lease-2',
          tenantId: 'tenant-b',
          runId: 'run-2',
        },
      }),
    );
    expect(fs.existsSync(claimPath)).toBe(true);
    const teardownSession = vi.fn<SessionTeardown>(async () => {});

    await leaseSessionEnd(sessionStore, teardownSession).ender.end('lease-1', reason);

    expect(teardownSession).toHaveBeenCalledTimes(1);
    expect(teardownSession.mock.lastCall?.[0].address).toBe('leased');
    expect(sessionStore.get('leased')).toBeUndefined();
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(sessionStore.get('other')).toBeDefined();
    expect(emitDiagnostic).toHaveBeenCalledWith({
      phase: 'leased_session_ended',
      data: { reason, session: 'leased', deviceKey: 'ios:simulator:fixture', leaseId: 'lease-1' },
    });
  },
);

test('end keeps the claim of a session whose teardown failed', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-unreachable-');
  const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');

  await leaseSessionEnd(sessionStore, async () => {
    throw new Error('device unreachable');
  }).ender.end('lease-1', 'LEASE_EXPIRED');

  expect(sessionStore.get('leased')).toBeDefined();
  expect(fs.existsSync(claimPath)).toBe(true);
});

test('a confirmed provider end keeps the claim when independent cleanup fails', async () => {
  vi.mocked(emitDiagnostic).mockClear();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    const sessionStore = makeSessionStore();
    const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');
    const stopSnapshotHelper = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('snapshot helper stop failed'));
    const teardown: SessionTeardown = (ref) =>
      settleExpiredSession({
        ref,
        sessionStore,
        appLog: 'run',
        platformCleanup: platformResourceCleanupFixture({ stopSnapshotHelper }),
        finalizeApplication: async () => {},
      });
    const { ender } = leaseSessionEnd(sessionStore, teardown);

    await ender.end('lease-1', 'PROVIDER_INSTANCE_ENDED');
    expect(Boolean(sessionStore.get('leased'))).toBe(true);
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(emitDiagnostic).toHaveBeenCalledWith({
      level: 'warn',
      phase: 'leased_session_ended',
      data: {
        reason: 'PROVIDER_INSTANCE_ENDED',
        session: 'leased',
        deviceKey: 'ios:simulator:fixture',
        leaseId: 'lease-1',
        failedSteps: ['platform_snapshot_helper'],
        error: expect.stringContaining('snapshot helper stop failed'),
      },
    });
    clock.mockReturnValue(11_000);
    await ender.retryPending();
    expect(stopSnapshotHelper).toHaveBeenCalledTimes(2);
    expect(Boolean(sessionStore.get('leased'))).toBe(false);
    expect(fs.existsSync(claimPath)).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

test.each([
  { firstAttemptFails: false, events: ['expired', 'settled'] },
  { firstAttemptFails: true, events: ['expired', 'incomplete', 'retry', 'settled'] },
] as const)(
  'expiry logs each transition with cause when the first attempt fails=$firstAttemptFails',
  async ({ firstAttemptFails, events }) => {
    vi.mocked(emitDiagnostic).mockClear();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const store = makeSessionStore();
      await publishLeasedSession(store, 'leased', 'lease-1');
      const teardown = vi.fn(async () => {});
      if (firstAttemptFails) teardown.mockRejectedValueOnce(new Error('teardown unavailable'));
      const { ender } = leaseSessionEnd(store, teardown);
      await ender.end('lease-1', 'LEASE_EXPIRED');
      clock.mockReturnValue(11_000);
      await ender.retryPending();

      expect(store.get('leased')).toBeUndefined();
      expect(teardown).toHaveBeenCalledTimes(firstAttemptFails ? 2 : 1);
      const transitions = vi
        .mocked(emitDiagnostic)
        .mock.calls.map(([event]) => event)
        .filter(({ phase }) => phase === 'lease_expiry_transition');
      expect(transitions.map(({ data }) => data)).toEqual(
        events.map((event) => {
          const [oldState, newState] = EXPIRY_TRANSITIONS[event];
          return {
            actor: 'daemon',
            event,
            oldState,
            newState,
            cause: 'LEASE_EXPIRED',
            session: 'leased',
            deviceKey: 'ios:simulator:fixture',
            leaseId: 'lease-1',
          };
        }),
      );
    } finally {
      clock.mockRestore();
    }
  },
);

test('provider release waits for a successful cleanup retry and the address stays reserved', async () => {
  vi.mocked(emitDiagnostic).mockClear();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    const store = makeSessionStore();
    await publishLeasedSession(store, 'leased', 'lease-1');
    const ref = store.lookup('leased')!;
    const teardown = vi.fn(async () => {}).mockRejectedValueOnce(new Error('stop unconfirmed'));
    let confirmed = false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const allowRelease = vi.fn();
    const ender = createLeaseSessionEnd({
      env: store.host.env,
      sessionStore: store,
      executionLocks: new Map(),
      teardownSession: teardown,
      cleanupSessionlessExecutionHost: async () => {},
      confirmExpiredSessions: () => confirmed,
    });

    await ender.end('lease-1', 'LEASE_EXPIRED', { done, allowRelease });
    expect(await ender.settlementFor(ref.lifetime)?.done).toBe(false);
    expect(allowRelease).not.toHaveBeenCalled();
    expect(ender.closingAt(ref.address)?.lifetime).toBe(ref.lifetime);

    clock.mockReturnValue(11_000);
    await ender.retryPending();
    expect(allowRelease).toHaveBeenCalledOnce();
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(store.lookup(ref.address)).toBeUndefined();
    expect(ender.closingAt(ref.address)?.lifetime).toBe(ref.lifetime);

    confirmed = true;
    finish();
    expect(await ender.settlementFor(ref.lifetime)?.done).toBe(true);
    expect(ender.closingAt(ref.address)).toBeUndefined();
    expect(emitDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leaseId: 'lease-1' }) }),
    );
  } finally {
    clock.mockRestore();
  }
});

test('end waits for the command still holding the session execution locks', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-locked-');
  await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  const teardownSession = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, teardownSession);
  const command = holdSessionLocks(executionLocks, sessionStore, 'leased');

  const ending = ender.end('lease-1', 'LEASE_RELEASED');
  await settle();
  expect(teardownSession).not.toHaveBeenCalled();
  expect(sessionStore.get('leased')).toBeDefined();

  command.finish();
  await command.held;
  await ending;
  expect(teardownSession).toHaveBeenCalledTimes(1);
  expect(sessionStore.get('leased')).toBeUndefined();
});

test('cancel stops a lease end still queued on the session locks from tearing down', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-cancel-');
  const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  const teardownSession = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, teardownSession);
  const command = holdSessionLocks(executionLocks, sessionStore, 'leased');

  const ending = ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  ender.cancel();
  command.finish();
  await command.held;
  await ending;

  expect(teardownSession).not.toHaveBeenCalled();
  expect(sessionStore.get('leased')).toBeDefined();
  expect(fs.existsSync(claimPath)).toBe(true);
  await ender.end('lease-1', 'LEASE_RELEASED');
  expect(teardownSession).not.toHaveBeenCalled();
});

test('drain waits for a lease end whose teardown is already running', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-drain-');
  await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  let finishTeardown!: () => void;
  const teardownStarted = vi.fn();
  const { ender } = leaseSessionEnd(sessionStore, async () => {
    teardownStarted();
    await new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
  });

  void ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  expect(teardownStarted).toHaveBeenCalledTimes(1);
  ender.cancel();
  let drained = false;
  const drain = ender.drain().then(() => {
    drained = true;
  });
  await settle();
  expect(drained).toBe(false);

  finishTeardown();
  await drain;
  expect(sessionStore.get('leased')).toBeUndefined();
});
