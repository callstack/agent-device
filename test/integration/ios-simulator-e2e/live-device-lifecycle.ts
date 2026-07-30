import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { requireDevice } from './live-assertions.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;

export async function assertDeviceLifecycle(context: LiveContext): Promise<void> {
  const reinstall = await runStep(context, 'reinstall cached fixture', [
    'reinstall',
    context.appId,
    context.appPath,
  ]);
  assert.equal(reinstall.json?.data?.bundleId, context.appId, JSON.stringify(reinstall.json));
  assert.equal(
    path.resolve(String(reinstall.json?.data?.appPath)),
    path.resolve(context.appPath),
    JSON.stringify(reinstall.json),
  );
  verifyCommand(context, C.reinstall, 'typed reinstall result retains fixture identity and path');

  let primaryError: unknown;
  try {
    const shutdown = await runStep(context, 'shutdown selected simulator', ['shutdown']);
    assert.equal(shutdown.json?.data?.id, context.udid, JSON.stringify(shutdown.json));
    assert.equal(shutdown.json?.data?.shutdown?.success, true, JSON.stringify(shutdown.json));
    const stoppedInventory = await runStep(context, 'verify simulator shutdown', ['devices']);
    assert.equal(requireDevice(stoppedInventory, context.udid).booted, false);
    verifyCommand(context, C.shutdown, 'inventory reports the selected simulator as shut down');

    const boot = await runStep(context, 'boot selected simulator', ['boot'], {
      timeoutMs: 300_000,
    });
    assert.equal(boot.json?.data?.id, context.udid, JSON.stringify(boot.json));
    assert.equal(boot.json?.data?.booted, true, JSON.stringify(boot.json));
    const bootedInventory = await runStep(context, 'verify simulator boot', ['devices']);
    assert.equal(requireDevice(bootedInventory, context.udid).booted, true);
    verifyCommand(context, C.boot, 'typed result and inventory report the simulator booted again');
  } catch (error) {
    primaryError = error;
  }

  if (primaryError === undefined) return;

  let recoveryError: unknown;
  try {
    const inventory = await runStep(context, 'cleanup: inspect simulator boot state', ['devices']);
    if (!requireDevice(inventory, context.udid).booted) {
      await runStep(context, 'cleanup: recover selected simulator', ['boot'], {
        timeoutMs: 300_000,
      });
    }
  } catch (error) {
    recoveryError = error;
  }
  if (recoveryError !== undefined) {
    throw new AggregateError(
      [primaryError, recoveryError],
      'device lifecycle failed and simulator recovery also failed',
    );
  }
  throw primaryError;
}
