import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test } from 'vitest';
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
