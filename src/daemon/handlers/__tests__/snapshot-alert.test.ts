import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionState } from '../../types.ts';
import { SessionStore } from '../../session-store.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../snapshot.ts';
import { snapshotRuntimeFixture } from '../../__tests__/snapshot-runtime-fixture.ts';
import { withAppleRunnerProvider } from '@agent-device/platform-apple/runner';
import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import path from 'node:path';

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
  sessionStore.set(sessionName, makeSession(sessionName));

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
  sessionStore.set(sessionName, makeSession(sessionName));
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
  sessionStore.set(sessionName, makeSession(sessionName));

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
