// #4791: plain `close` stops an Apple simulator only when open has positive proof that its OWN boot
// step performed the boot. The pre-open snapshot says only that the device was stopped when the open
// looked at it, so anything else could have booted it in the meantime — a concurrent `simctl boot`,
// another workspace, a person at the machine. Routed through the session command handler, so
// selection, readiness, claim acquisition, boot-ownership recording and close teardown all run for
// real. The platform's own boot report is answered by the lifecycle fixture at the port, exactly as
// the Apple readiness step answers it; the readiness mechanics themselves are pinned in the platform
// package's own suite.
import { beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import * as hostProcess from '@agent-device/host-kit/process';
import {
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
  pinOwnProcessStartTime,
} from '@agent-device/test-kit';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../../__tests__/support/device-selection-stub.ts');
  const resolveTargetDevice = vi.fn();
  return {
    ...actual,
    resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(resolveTargetDevice)),
  };
});

import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import type { DeviceBootPerformance } from '@agent-device/contracts/device-boot';
import { CLOSE_BOOT_OWNER_UNVERIFIED_REASONS } from '@agent-device/contracts/device-boot';
import {
  applicationLifecycleRuntimeFixture,
  type LifecycleOperationsLoader,
} from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import {
  handleSessionCommands,
  mockShutdownTargetRuntime,
} from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { SessionStore } from '../../../../core/session-store.ts';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import type { DeviceInfo } from '@agent-device/kernel/device';

pinOwnProcessStartTime(hostProcess);
bindTestCommandHost();

const SESSION = 'foreign-boot-session';

/** The simulator as inventory lists it while shut down, which is all the open's snapshot ever sees. */
const STOPPED_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-udid-4791',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: false,
};

/** The same simulator once it runs, which is what the open binds and the session holds. */
const BOOTED_SIMULATOR: DeviceInfo = { ...STOPPED_SIMULATOR, booted: true };

function createRoutedSession() {
  const stateDir = mkdtempForTestSync('agent-device-session-close-foreign-boot-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims'),
  };
  const sessionStore = new SessionStore(path.join(stateDir, 'sessions'), {
    env,
    cwd: process.cwd(),
  });

  /** Every open of this suite must state what its boot step reports; a close reports nothing. */
  type RunCommand =
    | {
        name: 'open';
        /** What the platform's own boot step reports about the open's preparation call. */
        bootPerformance: DeviceBootPerformance;
        /** Fails the open after its ownership write and before dispatch, keeping the session. */
        failBeforeDispatch?: boolean;
        flags?: Record<string, unknown>;
      }
    | { name: 'close'; flags?: Record<string, unknown> };

  async function run(command: RunCommand) {
    if (command.name === 'open') {
      // Selection sees a shut-down simulator, which is the inference #4791 refuses to act on alone.
      // A re-open of this session resolves the session's own device and infers no boot at all.
      vi.mocked(resolveTargetDevice).mockResolvedValue(STOPPED_SIMULATOR);
    }
    const loader: LifecycleOperationsLoader = async (device, signal, shutdownTarget) => {
      const operations = await applicationLifecycleRuntimeFixture(device, signal, shutdownTarget);
      return Object.freeze({
        ...operations,
        prepareApplicationOpen: async (
          input: Parameters<typeof operations.prepareApplicationOpen>[0],
        ) => {
          // An open states its boot report in its own command shape; a close prepares nothing.
          if (command.name === 'open') input.onBootPerformance?.(command.bootPerformance);
        },
      });
    };
    const response = await handleSessionCommands({
      host: createTestHostEnvironment({ env }),
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      sessionStore,
      invoke: async () => ({ ok: true, data: {} }),
      lifecycleOperationsLoader: loader,
      req: {
        token: 't',
        command: command.name,
        session: SESSION,
        positionals: command.name === 'open' ? ['Demo'] : [],
        flags: command.flags ?? {},
        ...(command.name === 'open' && command.failBeforeDispatch
          ? {
              internal: {
                openLifecycle: {
                  beforeDispatch: async () => ({
                    ok: false as const,
                    error: { code: 'COMMAND_FAILED' as const, message: 'Dispatch refused' },
                  }),
                },
              },
            }
          : {}),
      },
      sessionName: SESSION,
      logPath: path.join(stateDir, 'daemon.log'),
    });
    return response;
  }

  return { run, sessionStore, env };
}

function closeWarnings(response: { ok?: unknown; data?: unknown }): unknown {
  if (!response.ok) throw new Error('expected a successful close');
  return (response.data as { warnings?: string[] }).warnings;
}

beforeEach(() => {
  vi.mocked(resolveTargetDevice).mockReset();
  mockShutdownTargetRuntime.mockClear();
});

test('plain close keeps a simulator the platform says its own boot step never booted', async () => {
  const runs = createRoutedSession();

  // The snapshot said stopped, so selection inferred a boot; the platform's boot step then answered
  // that the simulator was already up when it asked, which is the foreign boot.
  const opened = await runs.run({
    name: 'open',
    bootPerformance: { performed: false, reason: 'already-booted' },
  });
  expect(opened?.ok).toBe(true);

  const session = runs.sessionStore.get(SESSION);
  expect(session?.bootedByOpen).toBeUndefined();
  expect(session?.bootOwnerUnverified).toBe(true);

  const closed = await runs.run({ name: 'close' });

  expect(closed?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  // The kept-running device is reported, and the reason is the published vocabulary member.
  expect(closeWarnings(closed!)).toEqual([
    expect.stringContaining(CLOSE_BOOT_OWNER_UNVERIFIED_REASONS.bootOwnerUnverified),
  ]);
  // A plain close that stops nothing still succeeds and retires the session with its claim.
  expect(runs.sessionStore.get(SESSION)).toBeUndefined();
  expect(inspectDeviceClaims({ serial: BOOTED_SIMULATOR.id }, runs.env)).toEqual([]);
}, 30_000);

test('plain close stops the simulator whose boot the platform reports performing', async () => {
  const runs = createRoutedSession();

  const opened = await runs.run({ name: 'open', bootPerformance: { performed: true } });
  expect(opened?.ok).toBe(true);
  expect(runs.sessionStore.get(SESSION)?.bootedByOpen).toBe(true);
  expect(runs.sessionStore.get(SESSION)?.bootOwnerUnverified).toBeUndefined();

  const closed = await runs.run({ name: 'close' });

  expect(closed?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarnings(closed!)).toBeUndefined();
  if (closed?.ok) expect(closed.data).toMatchObject({ shutdown: { success: true } });
}, 30_000);

test('close --shutdown commands the stop a disproved open withheld', async () => {
  // The state the warning actually creates: the user is told the device is still running and
  // answers with an explicit shutdown. That commands the stop without the ownership question.
  const runs = createRoutedSession();

  const opened = await runs.run({
    name: 'open',
    bootPerformance: { performed: false, reason: 'already-booted' },
  });
  expect(opened?.ok).toBe(true);

  const closed = await runs.run({ name: 'close', flags: { shutdown: true } });

  expect(closed?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarnings(closed!)).toBeUndefined();
  if (closed?.ok) expect(closed.data).toMatchObject({ shutdown: { success: true } });
}, 30_000);

test('a failed re-open cannot silence the disproved boot the session already reported', async () => {
  // The re-open writes ownership before dispatch and its own readiness finds the foreign boot up,
  // so it proves nothing. When its dispatch then fails, the surviving session keeps the record:
  // the same simulator is still running on somebody else's boot, and close must still say so.
  const runs = createRoutedSession();

  const opened = await runs.run({
    name: 'open',
    bootPerformance: { performed: false, reason: 'already-booted' },
  });
  expect(opened?.ok).toBe(true);

  const reopened = await runs.run({
    name: 'open',
    bootPerformance: { performed: false, reason: 'already-booted' },
    flags: {},
    failBeforeDispatch: true,
  });
  expect(reopened?.ok).toBe(false);
  expect(runs.sessionStore.get(SESSION)?.bootOwnerUnverified).toBe(true);

  const closed = await runs.run({ name: 'close' });

  expect(closed?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarnings(closed!)).toEqual([
    expect.stringContaining(CLOSE_BOOT_OWNER_UNVERIFIED_REASONS.bootOwnerUnverified),
  ]);
}, 30_000);
