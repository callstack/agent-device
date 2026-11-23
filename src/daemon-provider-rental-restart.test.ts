import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DeviceLease, LeaseLifecycleContext } from '@agent-device/contracts/device';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import {
  fakeInstanceId,
  fakeRentalKey,
  interruptionExitCode,
  rentalDaemonEnv,
  rentalRestartFixturePath,
  startRentalDaemon,
} from './daemon-provider-rental-restart.fixtures.ts';

const scope = {
  leaseId: '1234567890abcdef1234567890abcdef',
  tenantId: 'tenant-a',
  runId: 'run-a',
  leaseBackend: 'ios-simulator',
  leaseProvider: 'limrun',
  deviceKey: 'paid-device-a',
};

type Ready = { port: number; token: string };

async function send(ready: Ready, command: string, meta: object): Promise<DaemonResponse> {
  const { port, token } = ready;
  return await new Promise<DaemonResponse>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        JSON.stringify({ token, command, session: 'test', positionals: [], meta }) + '\n',
      );
    });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (!response.includes('\n')) return;
      socket.destroy();
      resolve(JSON.parse(response) as DaemonResponse);
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Daemon closed before replying.')));
  });
}

function startCrashingDaemon(stateDir: string, phase: string) {
  const child = fork(rentalRestartFixturePath, ['run-rental-restart-fixture', stateDir, phase], {
    execArgv: ['--experimental-strip-types'],
    env: rentalDaemonEnv(stateDir),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit').then(([code]) => code);
  const ready = new Promise<Ready>((resolve, reject) => {
    child.on('message', (message: Ready) => resolve(message));
    void exited.then(
      (code) => reject(new Error(`Fixture exited before readiness (${code}).`)),
      reject,
    );
  });

  return {
    exited,
    request: async (command: string) => await send(await ready, command, scope),
    close: async () => {
      if (child.connected) child.send('close');
      await exited;
    },
  };
}

async function restartDaemon(stateDir: string, phase: string) {
  const recovery: unknown[] = [];
  const daemon = await startRentalDaemon(stateDir, phase, (result) => recovery.push(result));
  return {
    recovery,
    request: (command: string, meta: object) => send(daemon, command, meta),
    close: () => daemon.runtime.close(),
  };
}

test.each([
  ['before-create', undefined, 'absent'],
  ['after-create', undefined, fakeInstanceId],
  ['after-identity', fakeInstanceId, fakeInstanceId],
  ['during-release', fakeInstanceId, fakeInstanceId],
  ['after-delete', fakeInstanceId, 'absent'],
])('recovers a rental after daemon exit %s', async (phase, instanceId, outcome) => {
  const stateDir = mkdtempForTestSync('agent-device-rental-restart-');
  const crashing = startCrashingDaemon(stateDir, phase);
  try {
    const crashOnRelease = phase === 'during-release' || phase === 'after-delete';
    if (crashOnRelease) expect((await crashing.request('lease_allocate')).ok).toBe(true);
    const command = crashOnRelease ? 'lease_release' : 'lease_allocate';
    await expect(crashing.request(command)).rejects.toThrow('Daemon closed before replying');
    expect(await crashing.exited).toBe(interruptionExitCode);
  } finally {
    await crashing.close();
  }
  const journal = fs.readFileSync(path.join(stateDir, 'provider-rentals.json'), 'utf8');
  expect(journal).not.toContain(scope.leaseId);
  const recovery = { reconciliationKey: fakeRentalKey, ...(instanceId ? { instanceId } : {}) };
  expect(JSON.parse(journal).rentals).toMatchObject([
    {
      lease: { deviceKey: scope.deviceKey, tenantId: scope.tenantId, runId: scope.runId },
      releaseOnRestart: recovery,
    },
  ]);

  const restarted = await restartDaemon(stateDir, 'recover');
  try {
    const successor = await restarted.request('lease_allocate', { ...scope, leaseId: undefined });
    expect(successor.ok).toBe(true);
    expect(restarted.recovery).toEqual([{ recovery, outcome }]);
  } finally {
    await restarted.close();
  }
});

test.each([
  ['unknown', 'recover-unknown'],
  ['before-key', 'recover-unknown'],
  ['after-identity', 'recover-other-credentials'],
])(
  'unconfirmed release stays fenced across daemon registrations (%s)',
  async (phase, recoveryPhase) => {
    const stateDir = mkdtempForTestSync('agent-device-rental-unknown-');
    const crashing = startCrashingDaemon(stateDir, phase);
    try {
      await expect(crashing.request('lease_allocate')).rejects.toThrow(
        'Daemon closed before replying',
      );
      expect(await crashing.exited).toBe(interruptionExitCode);
    } finally {
      await crashing.close();
    }

    for (let restart = 0; restart < 2; restart++) {
      const daemon = await restartDaemon(stateDir, recoveryPhase);
      try {
        const blocked = await daemon.request('lease_allocate', {
          ...scope,
          leaseId: undefined,
          tenantId: 'tenant-b',
          runId: 'different-run',
        });
        expect(blocked).toMatchObject({
          ok: false,
          error: {
            code: 'DEVICE_IN_USE',
            details: { reason: 'DEVICE_LEASE_BUSY', releaseStatus: 'unknown' },
          },
        });
        const unrelated = await daemon.request('lease_allocate', {
          ...scope,
          deviceKey: 'another-device',
          leaseId: undefined,
        });
        expect(unrelated).toMatchObject({ ok: true });
        expect(daemon.recovery[0]).toEqual(
          phase === 'unknown'
            ? { recovery: { reconciliationKey: fakeRentalKey }, outcome: 'unknown' }
            : undefined,
        );
      } finally {
        await daemon.close();
      }
    }
  },
);

test('a legacy recovery completing after shutdown leaves the pending record for the next daemon', async () => {
  const stateDir = mkdtempForTestSync('agent-device-rental-handoff-');
  const pendingPath = path.join(stateDir, 'expired-provider-leases.json');
  const now = Date.now();
  const lease = {
    ...scope,
    backend: scope.leaseBackend,
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now,
  };
  const record = JSON.stringify({ version: 1, leases: [lease] });
  fs.writeFileSync(pendingPath, record);
  let finishStop!: () => void;
  const oldStop = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  let attempts = 0;
  const daemon = await startRentalDaemon(stateDir, 'recover', () => {}, {
    recoverExpiredLease: async () => {
      if (++attempts === 1) throw new Error('Release temporarily unavailable.');
      await oldStop;
    },
  });
  try {
    const report = await daemon.runtime.close();
    expect(report.providerReleases.unknown).toContain(scope.leaseId);
    const successor = await startRentalDaemon(stateDir, 'recover', () => {}, {
      recoverExpiredLease: async () => {
        throw new Error('Release temporarily unavailable.');
      },
    });
    try {
      finishStop();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fs.existsSync(pendingPath)).toBe(true);
      expect(fs.readFileSync(pendingPath, 'utf8')).toBe(record);
    } finally {
      await successor.runtime.close();
    }
  } finally {
    finishStop();
    await daemon.runtime.close();
  }
});

test('failed rental journal retirement fences overlapping allocations and retries without another stop', async () => {
  const stateDir = mkdtempForTestSync('agent-device-rental-retirement-');
  const journalPath = path.join(stateDir, 'provider-rentals.json');
  const stop = vi.fn(async () => ({ release: 'confirmed' as const }));
  const legacyStop = vi.fn(async () => {});
  const daemon = await startRentalDaemon(stateDir, 'recover', () => {}, {
    recoverExpiredLease: legacyStop,
    leaseLifecycleProvider: {
      allocate: async (_lease, context) => {
        context?.rental?.beforeCreate(fakeRentalKey);
        context?.rental?.rented(fakeInstanceId);
        return { providerSessionId: fakeInstanceId };
      },
      release: stop,
    },
  });
  const next = { ...scope, leaseId: undefined, tenantId: 'tenant-b', runId: 'run-b' };
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, 'renameSync');
  try {
    expect(await send(daemon, 'lease_allocate', scope)).toMatchObject({ ok: true });
    failure.mockImplementation((from, to) => {
      if (to === journalPath) throw new Error('Journal publication unavailable.');
      rename(from, to);
    });
    expect(await send(daemon, 'lease_release', scope)).toMatchObject({
      ok: true,
      data: { released: false },
    });
    expect(await send(daemon, 'lease_allocate', next)).toMatchObject({
      ok: false,
      error: {
        code: 'DEVICE_IN_USE',
        details: { reason: 'provider-rental-retirement-pending' },
      },
    });
    expect(JSON.parse(fs.readFileSync(journalPath, 'utf8')).rentals).toHaveLength(1);
    failure.mockRestore();
    await vi.waitFor(
      () => {
        expect(JSON.parse(fs.readFileSync(journalPath, 'utf8')).rentals).toEqual([]);
      },
      { timeout: 4_000 },
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(legacyStop).not.toHaveBeenCalled();
    expect(await send(daemon, 'lease_allocate', next)).toMatchObject({ ok: true });
  } finally {
    failure.mockRestore();
    await daemon.runtime.close();
  }
});

test('a live provider lease ID with a different scope is already in use', async () => {
  const stateDir = mkdtempForTestSync('agent-device-rental-duplicate-');
  const daemon = await startRentalDaemon(stateDir, 'recover', () => {});
  try {
    expect(await send(daemon, 'lease_allocate', scope)).toMatchObject({ ok: true });
    expect(
      await send(daemon, 'lease_allocate', { ...scope, tenantId: 'tenant-b', deviceKey: 'other' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS', details: { reason: 'LEASE_ID_IN_USE' } },
    });
  } finally {
    await daemon.runtime.close();
  }
});

test('a changed runtime identity cannot confirm absence for an inherited rental', async () => {
  const stateDir = mkdtempForTestSync('agent-device-rental-runtime-');
  const journalPath = path.join(stateDir, 'provider-rentals.json');
  const allocate = async (_lease: DeviceLease, context?: LeaseLifecycleContext) => {
    context?.rental?.beforeCreate(fakeRentalKey);
    context?.rental?.rented(fakeInstanceId);
    return { providerSessionId: fakeInstanceId };
  };
  const original = await startRentalDaemon(stateDir, 'recover', () => {}, {
    providerRentalPolicy: () => ({ runtimeIdentity: 'original-runtime', legacyRecovery: false }),
    leaseLifecycleProvider: { allocate, release: async () => ({ release: 'unknown' }) },
  });
  try {
    expect(await send(original, 'lease_allocate', scope)).toMatchObject({ ok: true });
  } finally {
    await original.runtime.close();
  }
  const record = fs.readFileSync(journalPath, 'utf8');
  const recoverRental = vi.fn(async () => true);
  const changed = await startRentalDaemon(stateDir, 'recover', () => {}, {
    providerRentalPolicy: () => ({ runtimeIdentity: 'other-runtime', legacyRecovery: false }),
    leaseLifecycleProvider: { allocate, recoverRental },
  });
  try {
    expect(recoverRental).not.toHaveBeenCalled();
    expect(await send(changed, 'lease_allocate', { ...scope, leaseId: undefined })).toMatchObject({
      ok: false,
      error: { code: 'DEVICE_IN_USE' },
    });
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(record);
  } finally {
    await changed.runtime.close();
  }
});

test('a provider with legacy-only recovery receives the original lease ID after restart', async () => {
  const stateDir = mkdtempForTestSync('agent-device-rental-legacy-provider-');
  const providerRentalPolicy = () => ({ legacyRecovery: true });
  const original = await startRentalDaemon(stateDir, 'recover', () => {}, {
    providerRentalPolicy,
    recoverExpiredLease: async () => {
      throw new Error('Release temporarily unavailable.');
    },
    leaseLifecycleProvider: {
      allocate: async () => ({}),
      release: async () => ({ release: 'unknown' }),
    },
  });
  try {
    expect(await send(original, 'lease_allocate', scope)).toMatchObject({ ok: true });
  } finally {
    await original.runtime.close();
  }
  const recoverExpiredLease = vi.fn(async (_lease: DeviceLease) => {});
  const successor = await startRentalDaemon(stateDir, 'recover', () => {}, {
    providerRentalPolicy,
    recoverExpiredLease,
    leaseLifecycleProvider: {},
  });
  try {
    expect(recoverExpiredLease).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ leaseId: scope.leaseId, deviceKey: scope.deviceKey }),
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, 'provider-rentals.json'), 'utf8')).rentals,
    ).toEqual([]);
  } finally {
    await successor.runtime.close();
  }
});

test('an exact ID that could not be written prevents allocation from settling successfully', async () => {
  const stateDir = mkdtempForTestSync('agent-device-rental-record-instance-');
  const journalPath = path.join(stateDir, 'provider-rentals.json');
  const stop = vi.fn(async () => ({ release: 'unknown' as const }));
  const daemon = await startRentalDaemon(stateDir, 'recover', () => {}, {
    leaseLifecycleProvider: {
      allocate: async (_lease, context) => {
        context?.rental?.beforeCreate(fakeRentalKey);
        context?.rental?.rented(fakeInstanceId);
        return { providerSessionId: fakeInstanceId };
      },
      release: stop,
    },
  });
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === journalPath && fs.readFileSync(from, 'utf8').includes(fakeInstanceId))
      throw new Error('Exact ID publication unavailable.');
    rename(from, to);
  });
  try {
    expect(await send(daemon, 'lease_allocate', scope)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Exact ID publication unavailable') },
    });
    expect(stop).toHaveBeenCalled();
    expect(await send(daemon, 'lease_allocate', { ...scope, leaseId: undefined })).toMatchObject({
      ok: false,
      error: { code: 'DEVICE_IN_USE', details: { releaseStatus: 'unknown' } },
    });
    expect(fs.readFileSync(journalPath, 'utf8')).not.toContain(fakeInstanceId);
    failure.mockRestore();
    await vi.waitFor(
      () => {
        expect(JSON.parse(fs.readFileSync(journalPath, 'utf8')).rentals).toMatchObject([
          { releaseOnRestart: { reconciliationKey: fakeRentalKey, instanceId: fakeInstanceId } },
        ]);
      },
      { timeout: 4_000 },
    );
  } finally {
    failure.mockRestore();
    await daemon.runtime.close();
  }
});
