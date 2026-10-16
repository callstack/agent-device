import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionState } from '../../../core/session-state.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../../../sessions/handlers/snapshot.ts';
import { snapshotRuntimeFixture } from '../../../__tests__/support/snapshot-runtime-fixture.ts';
import { withAppleRunnerProvider } from '@agent-device/platform-apple/runner';
import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import path from 'node:path';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(async () => ({})) };
});

const iosSimulatorDevice: SessionState['device'] = {
  platform: 'apple',
  id: 'sim-1',
  name: 'My iPhone Simulator',
  kind: 'simulator',
  booted: true,
};
const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-snapshot-alert-');
  return new SessionStore(path.join(root, 'sessions'));
}

function makeSession(name: string): SessionState {
  return { name, device: iosSimulatorDevice, createdAt: Date.now(), actions: [] };
}

async function handleSnapshotCommands(
  sessionName: string,
  sessionStore: SessionStore,
  positionals: string[],
): Promise<Awaited<ReturnType<typeof handleProductionSnapshotCommands>>> {
  return await withAppleRunnerProvider(mockRunnerCommand, { deviceId: iosSimulatorDevice.id }, () =>
    handleProductionSnapshotCommands({
      createCommandSurface: fakeCreateCommandSurface,
      req: { token: 't', session: sessionName, command: 'alert', positionals, flags: {} },
      sessionName,
      logPath: '/tmp/daemon.log',
      sessionStore,
      ...snapshotRuntimeFixture(),
    }),
  );
}

function alertAbsence(message = 'alert not found'): AppError {
  return new AppError('COMMAND_FAILED', message, { runnerErrorCode: 'ALERT_NOT_FOUND' });
}

beforeEach(() => {
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockResolvedValue({});
});

test('alert accept retries a typed alert absence and succeeds on the second attempt', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));

  let calls = 0;
  mockRunnerCommand.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) throw alertAbsence();
    return { accepted: true };
  });

  const response = await handleSnapshotCommands(sessionName, sessionStore, ['accept']);

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toBe(2);
  expect(mockRunnerCommand.mock.calls[0]?.[1]).toMatchObject({
    command: 'alert',
    action: 'accept',
    timeoutMs: 10_000,
  });
});

test('alert accept adds a scoped-snapshot hint after retrying alert-not-found failures', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockRunnerCommand.mockRejectedValue(alertAbsence());

  let thrown: unknown;
  try {
    await handleSnapshotCommands(sessionName, sessionStore, ['accept']);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).message).toBe('alert not found');
  expect((thrown as AppError).details?.hint).toMatch(/scoped snapshot/i);
});

test('alert dismiss retries a typed absence whatever the message says', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));

  let calls = 0;
  mockRunnerCommand.mockImplementation(async () => {
    calls += 1;
    if (calls < 3) throw alertAbsence('no alert present');
    return { dismissed: true };
  });

  const response = await handleSnapshotCommands(sessionName, sessionStore, ['dismiss']);

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toBe(3);
});

for (const action of ['accept', 'dismiss']) {
  test(`alert ${action} succeeds without journaling after its admitted lifetime ends`, async () => {
    const store = makeSessionStore();
    const name = 'ios-alert-retirement';
    const retired = store.publish(name, makeSession(name));
    let successor: SessionState | undefined;
    mockRunnerCommand.mockImplementationOnce(async () => {
      store.retire(retired);
      successor = makeSession(name);
      store.publish(name, successor);
      return { [action === 'accept' ? 'accepted' : 'dismissed']: true };
    });
    const response = await handleSnapshotCommands(name, store, [action]);
    expect(response?.ok).toBe(true);
    expect(mockRunnerCommand).toHaveBeenCalledOnce();
    expect(retired.session.actions).toEqual([]);
    expect(successor?.actions).toEqual([]);
  });
}

test('alert wait forwards its timeout budget to the runtime leg', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));

  await handleSnapshotCommands(sessionName, sessionStore, ['wait', '1500']);

  // The ceiling test below proves the refusal; this proves a legal budget crosses the runtime
  // seam whole. (The Apple runner leg reads the state as `get` and waits on its own deadline.)
  expect(mockRunnerCommand.mock.calls[0]?.[1]).toMatchObject({
    command: 'alert',
    timeoutMs: 1_500,
  });
});

test('alert wait refuses a budget past the window ceiling instead of arming a misfired timer', async () => {
  // Above 2^31-1 ms Node's timer overflows: `AbortSignal.timeout` throws outright and a bare
  // setTimeout fires after 1 ms. The refusal must be the typed argument error, never either.
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));

  await expect(
    handleSnapshotCommands(sessionName, sessionStore, ['wait', '4294967296']),
  ).rejects.toThrow(/exceeds the maximum/);
  await expect(
    handleSnapshotCommands(sessionName, sessionStore, ['wait', '2147483648']),
  ).rejects.toThrow(/exceeds the maximum/);
  expect(mockRunnerCommand).not.toHaveBeenCalled();
});
