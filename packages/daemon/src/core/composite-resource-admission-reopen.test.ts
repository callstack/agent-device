import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { resourceAdmissionWorld, assertRpcOk } from './composite-resource-admission.fixtures.ts';
import { seedExistingCapture } from './composite-resource-existing.fixtures.ts';

test.each(['audio-probe', 'perf-capture', 'screen-recording'] as const)(
  'bounded reopen preserves owned %s across app switch and relaunch',
  async (kind) => {
    const world = await resourceAdmissionWorld();
    try {
      const owned = seedExistingCapture(world, kind);
      const before = fs.readFileSync(owned.resourcePath);
      const initial = world.sessionStore.requireCurrent(world.ref);
      const resource =
        kind === 'audio-probe'
          ? initial.audioProbe
          : kind === 'perf-capture'
            ? initial.perfCapture
            : initial.screenRecording;
      for (const relaunch of [false, true]) {
        assertRpcOk(
          await world.call('batch', [], {
            batchSteps: [
              { command: 'open', positionals: ['com.example.other'], flags: { relaunch } },
            ],
          }),
        );
        const current = world.sessionStore.requireCurrent(world.ref);
        expect(current).toMatchObject({
          appBundleId: 'com.example.other',
          ...owned.patch,
        });
        expect(
          kind === 'audio-probe'
            ? current.audioProbe
            : kind === 'perf-capture'
              ? current.perfCapture
              : current.screenRecording,
        ).toBe(resource);
        expect(fs.readFileSync(owned.resourcePath)).toEqual(before);
        expect(owned.finish).not.toHaveBeenCalled();
        expect(owned.forceCleanup).not.toHaveBeenCalled();
      }
    } finally {
      await world.daemon.close();
    }
  },
);

test('bounded existing-session app switch keeps the owned app log and claim', async () => {
  const world = await resourceAdmissionWorld();
  try {
    world.sessionStore.retire(world.ref);
    assertRpcOk(await world.call('open', ['com.android.settings']));
    assertRpcOk(await world.call('logs', ['start']));
    const ref = world.sessionStore.lookup('resource-session')!;
    const beforeSession = world.sessionStore.requireCurrent(ref);
    const log = beforeSession.appLog;
    const claim = beforeSession.deviceClaim;
    expect(claim).toBeDefined();
    const manifest = path.join(
      world.sessionStore.resolveSessionDir('resource-session'),
      'app-log.resource.json',
    );
    const beforeManifest = fs.readFileSync(manifest);
    assertRpcOk(await world.call('open', ['com.example.direct']));
    const response = await world.call('batch', [], {
      batchSteps: [{ command: 'open', positionals: ['com.example.other'] }],
    });
    assertRpcOk(response);
    const current = world.sessionStore.requireCurrent(ref);
    expect(current).toMatchObject({
      appBundleId: 'com.example.other',
      appLog: log,
      deviceClaim: claim,
    });
    expect(current.appLog).toBe(log);
    expect(current.deviceClaim).toBe(claim);
    expect(fs.readFileSync(manifest)).toEqual(beforeManifest);
    expect(world.finish).not.toHaveBeenCalled();
    expect(world.forceCleanup).not.toHaveBeenCalled();
    expect(world.providerRelease).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test('bounded relaunch preserves the app-log handle and manifest', async () => {
  const world = await resourceAdmissionWorld();
  try {
    assertRpcOk(await world.call('logs', ['start']));
    const log = world.sessionStore.requireCurrent(world.ref).appLog;
    const manifest = path.join(
      world.sessionStore.resolveSessionDir('resource-session'),
      'app-log.resource.json',
    );
    const before = fs.readFileSync(manifest);
    assertRpcOk(
      await world.call('batch', [], {
        batchSteps: [
          { command: 'open', positionals: ['com.android.settings'], flags: { relaunch: true } },
        ],
      }),
    );
    expect(world.sessionStore.requireCurrent(world.ref).appLog).toBe(log);
    expect(fs.readFileSync(manifest)).toEqual(before);
    expect(world.finish).not.toHaveBeenCalled();
    expect(world.forceCleanup).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});
