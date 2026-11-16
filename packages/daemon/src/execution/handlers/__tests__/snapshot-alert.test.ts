import { platformRequestScopeFixture } from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  ALERT_RUNNER_MAX_BUDGET_MS,
  ALERT_WAIT_WINDOW_TOO_LONG_REASON,
  DEFAULT_ALERT_TIMEOUT_MS,
  MAX_ALERT_WINDOW_MS,
} from '@agent-device/contracts/alert-contract';
import { MAX_ARMABLE_ALERT_WAIT_WINDOW_MS } from '@agent-device/command-registry/timeout-policy';
import type { SessionState } from '../../../core/session-state.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../../../sessions/handlers/snapshot.ts';
import { snapshotRuntimeFixture } from '../../../__tests__/support/snapshot-runtime-fixture.ts';
import { withAppleRunnerProvider } from '@agent-device/apple-runner';
import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
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
  return new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
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
      requestScope: platformRequestScopeFixture(),
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

test('alert parses its subaction case-insensitively, as the registry classifies it', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));

  const response = await handleSnapshotCommands(sessionName, sessionStore, ['ACCEPT']);

  expect(response?.ok).toBe(true);
  expect(mockRunnerCommand.mock.calls[0]?.[1]).toMatchObject({
    command: 'alert',
    action: 'accept',
  });
});

test('alert refuses an unknown subaction instead of reading the alert', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));

  await expect(
    handleSnapshotCommands(sessionName, sessionStore, ['acceptt']),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(mockRunnerCommand).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)?.actions).toEqual([]);
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

test('alert get reports a visible prompt the runner could not read, never as absence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockRunnerCommand.mockRejectedValue(
    new AppError('ALERT_UNRESOLVED', 'a system prompt is visible', {
      runnerErrorCode: 'ALERT_UNRESOLVED',
      dispatched: 'no',
      hint: 'Inspect it with screenshot, then snapshot -i.',
    }),
  );

  await expect(handleSnapshotCommands(sessionName, sessionStore, ['get'])).rejects.toMatchObject({
    code: 'ALERT_UNRESOLVED',
    details: { dispatched: 'no', hint: expect.stringMatching(/screenshot/) },
  });
  expect(mockRunnerCommand).toHaveBeenCalledOnce();
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

// #4566: the envelope the client arms for a wait is a timer as well, armed above the window with
// the daemon-result margin. So the wait ceiling the command honours is the armable window, and a
// window above it is refused up front with the typed reason rather than polled and then cut off.
test('alert wait refuses a window the request envelope cannot be armed for, naming what it accepts', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));

  const refusal = await handleSnapshotCommands(sessionName, sessionStore, [
    'wait',
    String(MAX_ARMABLE_ALERT_WAIT_WINDOW_MS + 1),
  ]).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(AppError);
  expect((refusal as AppError).code).toBe('INVALID_ARGS');
  expect((refusal as AppError).details?.reason).toBe(ALERT_WAIT_WINDOW_TOO_LONG_REASON);
  expect((refusal as AppError).details?.maxWaitWindowMs).toBe(MAX_ARMABLE_ALERT_WAIT_WINDOW_MS);
  // The contract's own larger ceiling is refused for the same typed reason: the command never
  // accepts a window it cannot honour and shortens it on the way down.
  await expect(
    handleSnapshotCommands(sessionName, sessionStore, ['wait', String(MAX_ALERT_WINDOW_MS)]),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    details: {
      reason: ALERT_WAIT_WINDOW_TOO_LONG_REASON,
      maxWaitWindowMs: MAX_ARMABLE_ALERT_WAIT_WINDOW_MS,
    },
  });
  expect(mockRunnerCommand).not.toHaveBeenCalled();

  // The largest window the command does honour reaches the leg as the caller's own window, and an
  // `alert get` keeps spending its own bounded read budget whatever the number says (#4540).
  mockRunnerCommand.mockResolvedValueOnce({ status: 'visible' });
  const waited = await handleSnapshotCommands(sessionName, sessionStore, [
    'wait',
    String(MAX_ARMABLE_ALERT_WAIT_WINDOW_MS),
  ]);
  expect(waited?.ok).toBe(true);
  expect(mockRunnerCommand.mock.calls.at(-1)?.[1]).toMatchObject({
    command: 'alert',
    action: 'get',
    // One runner attempt is capped at the runner's own alert budget, whatever the window says.
    timeoutMs: ALERT_RUNNER_MAX_BUDGET_MS,
  });
});

test('an alert wait window inside the ceiling reaches the polling leg while the other legs keep their own budgets', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockRunnerCommand.mockResolvedValue({ accepted: true, dismissed: true, status: 'visible' });

  // `wait` enters the polling leg, whose first attempt takes the runner's capped budget — the
  // window is the poll's extent, not one attempt's budget (#4540).
  await handleSnapshotCommands(sessionName, sessionStore, ['wait', '120000']);
  expect(mockRunnerCommand.mock.calls.at(-1)?.[1]).toMatchObject({
    command: 'alert',
    action: 'get',
    timeoutMs: ALERT_RUNNER_MAX_BUDGET_MS,
  });
  // `get` still spends its own clamped read budget, unchanged by the envelope it now travels under.
  await handleSnapshotCommands(sessionName, sessionStore, ['get', '120000']);
  expect(mockRunnerCommand.mock.calls.at(-1)?.[1]).toMatchObject({
    command: 'alert',
    action: 'get',
    timeoutMs: ALERT_RUNNER_MAX_BUDGET_MS,
  });
  // `accept` ignores the number and runs its own action budget, as `dismiss` does.
  await handleSnapshotCommands(sessionName, sessionStore, ['accept', '120000']);
  expect(mockRunnerCommand.mock.calls.at(-1)?.[1]).toMatchObject({
    command: 'alert',
    action: 'accept',
    timeoutMs: DEFAULT_ALERT_TIMEOUT_MS,
  });
});
