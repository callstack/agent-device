import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mockResolveTargetDevice } from './session-test-harness.ts';
import {
  mockEnsureReadyRuntime,
  mockShutdownTargetRuntime,
  readinessDeviceRuntimeGateway,
} from './session-command-harness.ts';
import { normalizeError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../../__tests__/test-utils/device-claim-store.ts';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { acquireDeviceClaim } from '../../device-claims.ts';
import { inspectDeviceClaims } from '../../device-claim-inspection.ts';
import { createRequestExecutionScope } from '../../request-execution-scope.ts';
import { handleSessionStateCommands } from '../session-state.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';

// #1799: `boot`/`shutdown` route through a daemon that need not own the target
// device. Two daemons on one host each keep their own state directory, so the
// host-global claim store is their only shared authority. These tests are shaped
// like that pair: daemon A's claim is written directly, then daemon B (a second
// state directory) runs the command through the production request-execution
// scope — the seam every device-mutating handler must pass through.

const setup = isolatedDeviceClaimStores('agent-device-boot-shutdown-claim-');
const OWNER_STATE_DIR_NAME = 'daemon-a';

function daemonB(stateDir: string): SessionStore {
  return new SessionStore(path.join(stateDir, 'sessions'));
}

async function claimForeignDaemon(root: string): Promise<string> {
  const ownerStateDir = path.join(root, OWNER_STATE_DIR_NAME);
  fs.mkdirSync(ownerStateDir, { recursive: true });
  const acquired = await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owner-session',
    workspace: '/worktrees/daemon-a',
    stateDir: ownerStateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  expect(acquired.status).toBe('acquired');
  return ownerStateDir;
}

/** Mirrors the router: the scope disposes, and a thrown request error normalizes. */
async function runStateCommand(
  command: 'boot' | 'shutdown',
  store: SessionStore,
): Promise<DaemonResponse | null> {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command,
    positionals: [],
    flags: { platform: 'android', serial: ANDROID_EMULATOR.id },
    meta: { cwd: '/worktrees/daemon-b' },
  };
  const scope = await createRequestExecutionScope({
    req,
    sessionStore: store,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: readinessDeviceRuntimeGateway,
    platformRequestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  try {
    return await handleSessionStateCommands({
      req,
      sessionName: 'default',
      sessionStore: store,
      inspectFacts: scope.inspectFacts,
      bindDevice: scope.bindDevice,
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  } finally {
    await scope[Symbol.asyncDispose]();
  }
}

test('shutdown refuses a device held by a foreign live claim and never reaches the device', async () => {
  const { root, stateDir } = setup();
  const ownerStateDir = await claimForeignDaemon(root);
  mockResolveTargetDevice.mockResolvedValue(ANDROID_EMULATOR);

  const response = await runStateCommand('shutdown', daemonB(stateDir));

  expect(response?.ok).toBe(false);
  if (!response || response.ok) return;
  expect(response.error.code).toBe('DEVICE_IN_USE');
  expect(response.error.retriable).toBe(false);
  expect(response.error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(response.error.details?.owner).toEqual({
    session: 'owner-session',
    workspace: '/worktrees/daemon-a',
    stateDir: ownerStateDir,
  });
  expect(response.error.hint).toBe(
    'Inspect the owner with: agent-device device status --platform android --serial emulator-5554',
  );
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  // The refusal leaves the owner's claim exactly as it was.
  expect(inspectDeviceClaims({}).map((entry) => entry.claim?.session)).toEqual(['owner-session']);
});

test('boot refuses a device held by a foreign live claim and never reaches the device', async () => {
  const { root, stateDir } = setup();
  await claimForeignDaemon(root);
  mockResolveTargetDevice.mockResolvedValue({ ...ANDROID_EMULATOR, booted: false });

  const response = await runStateCommand('boot', daemonB(stateDir));

  expect(response?.ok).toBe(false);
  if (!response || response.ok) return;
  expect(response.error.code).toBe('DEVICE_IN_USE');
  expect(response.error.retriable).toBe(false);
  expect(response.error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(mockEnsureReadyRuntime).not.toHaveBeenCalled();
});

test('shutdown on an unclaimed device succeeds and releases its transient claim', async () => {
  const { stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(ANDROID_EMULATOR);

  const response = await runStateCommand('shutdown', daemonB(stateDir));

  expect(response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledOnce();
  expect(inspectDeviceClaims({})).toEqual([]);
});

test('a failing shutdown still releases its transient claim', async () => {
  const { stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(ANDROID_EMULATOR);
  mockShutdownTargetRuntime.mockRejectedValue(new Error('adb emu kill failed'));

  const response = await runStateCommand('shutdown', daemonB(stateDir));

  expect(response?.ok).toBe(false);
  expect(inspectDeviceClaims({})).toEqual([]);
});
