import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, test } from 'vitest';
import { canonicalLocalDeviceKey } from '@agent-device/daemon-contracts/device-claims';
import { deviceIdentity } from '@agent-device/kernel/device';
import { resourceAdmissionWorld, assertRpcOk } from './composite-resource-admission.fixtures.ts';
import { seedExistingCapture } from './composite-resource-existing.fixtures.ts';

test.each(['perf-capture', 'trace-log'] as const)(
  'bounded close preserves existing %s without binding',
  async (kind) => {
    const world = await resourceAdmissionWorld();
    try {
      const owned = kind === 'perf-capture' ? seedExistingCapture(world, kind) : undefined;
      if (kind === 'trace-log') {
        world.sessionStore.update(world.ref, {
          trace: { outPath: '/tmp/owned.trace', startedAt: 1 },
        });
      }
      const before = owned ? fs.readFileSync(owned.resourcePath, 'utf8') : undefined;
      const response = await world.call('batch', [], { batchSteps: [{ command: 'close' }] });
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: `session-resource-disposal:${kind}`,
        standaloneCommandName: 'close',
        dispatched: 'no',
        executed: 0,
      });
      expect(world.bind).not.toHaveBeenCalled();
      expect(world.inspectFacts).not.toHaveBeenCalled();
      if (owned) {
        expect(owned.finish).not.toHaveBeenCalled();
        expect(fs.readFileSync(owned.resourcePath, 'utf8')).toBe(before);
        expect(world.sessionStore.requireCurrent(world.ref)).toMatchObject(owned.patch);
      } else {
        expect(world.sessionStore.requireCurrent(world.ref).trace).toEqual({
          outPath: '/tmp/owned.trace',
          startedAt: 1,
        });
      }
    } finally {
      await world.daemon.close();
    }
  },
);

test('bounded reopen keeps an owned IME and skips close teardown inspection', async () => {
  const world = await resourceAdmissionWorld('capture', {
    ime: { activate: async () => {}, restore: async () => {}, inspect: () => ['android-test-ime'] },
  });
  try {
    assertRpcOk(
      await world.call('batch', [], {
        batchSteps: [
          { command: 'open', positionals: ['com.android.settings'], flags: { relaunch: true } },
        ],
      }),
    );
    expect(world.inspectTeardown).not.toHaveBeenCalled();
    expect(world.sessionStore.requireCurrent(world.ref).name).toBe('resource-session');
  } finally {
    await world.daemon.close();
  }
});

test('invalid foreground reopen preserves the open validity error before resource refusal', async () => {
  const world = await resourceAdmissionWorld();
  try {
    const owned = seedExistingCapture(world, 'audio-probe');
    const before = fs.readFileSync(owned.resourcePath, 'utf8');
    const response = await world.call('batch', [], {
      batchSteps: [{ command: 'open', flags: { foreground: true } }],
    });
    expect(response.json.error?.data).toMatchObject({
      code: 'INVALID_ARGS',
      details: { executed: 0 },
    });
    expect(response.json.error?.data?.message).toContain('fresh session');
    expect(world.bind).not.toHaveBeenCalled();
    expect(world.inspectFacts).not.toHaveBeenCalled();
    expect(owned.finish).not.toHaveBeenCalled();
    expect(fs.readFileSync(owned.resourcePath, 'utf8')).toBe(before);
  } finally {
    await world.daemon.close();
  }
});

test('bounded close may release a local lease when the daemon has no provider release', async () => {
  const world = await resourceAdmissionWorld();
  try {
    const lease = world.leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-a' });
    world.sessionStore.update(world.ref, {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
      },
    });
    assertRpcOk(await world.call('batch', [], { batchSteps: [{ command: 'close' }] }));
    expect(world.providerRelease).not.toHaveBeenCalled();
    expect(world.leaseRegistry.inspectLeaseForClose(lease)).toBeUndefined();
  } finally {
    await world.daemon.close();
  }
});

test('active provider device skips local foreign-claim preview', async () => {
  const world = await resourceAdmissionWorld('capture', { providerOwned: true });
  try {
    const device = world.sessionStore.requireCurrent(world.ref).device;
    const deviceKey = canonicalLocalDeviceKey(deviceIdentity(device));
    const claimsDir = path.join(world.daemon.stateDir, 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = path.join(
      claimsDir,
      `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
    );
    fs.writeFileSync(
      claimPath,
      JSON.stringify({
        schemaVersion: 3,
        deviceKey,
        device: { ...deviceIdentity(device), name: device.name },
        session: 'foreign',
        workspace: '/foreign',
        stateDir: '/foreign/state',
        ownerPid: process.ppid,
        ownerStartTime: null,
        ownerToken: 'foreign-token',
        createdAtMs: 1,
        updatedAtMs: 1,
        claimOwnerKind: 'open-session',
      }),
    );
    const before = fs.readFileSync(claimPath);
    assertRpcOk(
      await world.call('batch', [], {
        batchSteps: [
          { command: 'open', positionals: ['com.android.settings'], flags: { relaunch: true } },
        ],
      }),
    );
    expect(fs.readFileSync(claimPath)).toEqual(before);
  } finally {
    await world.daemon.close();
  }
});
