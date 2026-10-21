import assert from 'node:assert/strict';
import type { ExecResult } from '@agent-device/host-kit/command';
import { getRequestSignal, withRequestDeadline } from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import { executeRunnerExchange } from '../../runner/runner-exchange.ts';
import { RunnerCommandAccounting, type RunnerSession } from '../../runner/runner-session-types.ts';
import { IOS_SIMULATOR } from '../../runner/__tests__/device-fixtures.ts';
import { startFakeRunnerServer } from '../../runner/__tests__/fake-runner-server.ts';
import { installAppleRunnerTestHost, loadAppleRunnerHost } from '../../runner/test-host.ts';
import { test, vi } from 'vitest';

test('a daemon deadline follows the ordinary canceled Apple runner journal drain', async () => {
  installAppleRunnerTestHost(await loadAppleRunnerHost());
  const runner = await startFakeRunnerServer({
    longPress: [{ kind: 'hold' }],
    status: [
      { kind: 'ok', data: { lifecycleState: 'started' } },
      { kind: 'ok', data: { lifecycleState: 'completed' } },
    ],
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  const realSetTimeout = globalThis.setTimeout;
  let fireDeadline: (() => void) | undefined;
  const timerSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((callback, delay, ...args) => {
      if (fireDeadline === undefined) {
        assert.equal(delay, 25);
        fireDeadline = () => callback(...args);
        return realSetTimeout(() => {}, delay);
      }
      return realSetTimeout(callback, delay, ...args);
    });
  try {
    const session: RunnerSession = {
      sessionId: `deadline-journal:${runner.port}`,
      device: IOS_SIMULATOR,
      deviceId: IOS_SIMULATOR.id,
      endpoint: { port: runner.port, token: 'runner-token-fixture' },
      xctestrunPath: '/tmp/fake.xctestrun',
      jsonPath: '/tmp/fake.json',
      testPromise: new Promise<ExecResult>(() => {}),
      child: { pid: process.pid, exitCode: null },
      state: 'ready',
      commandCharges: new RunnerCommandAccounting(),
    };
    const requestId = `deadline-journal:${runner.port}`;

    const deadlineResult = withRequestDeadline(requestId, 25, async () => {
      await executeRunnerExchange(
        IOS_SIMULATOR,
        session,
        {
          command: 'longPress',
          x: 10,
          y: 10,
          durationMs: 5_000,
          appBundleId: 'com.example.app',
        },
        undefined,
        10_000,
        async () => {},
        getRequestSignal(requestId),
      );
      return { ok: true };
    });
    deadlineResult.catch(() => {});

    const giveUpAtMs = performance.now() + 2_000;
    while (!runner.requests.some((request) => request.command === 'longPress')) {
      if (performance.now() >= giveUpAtMs) {
        throw new Error('The fake runner did not admit longPress before the deadline advanced.');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(fireDeadline);
    vi.setSystemTime(Date.now() + 25);
    fireDeadline();

    await assert.rejects(
      deadlineResult,
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'daemon_request_timeout',
    );
    const commandId = runner.requests.find((request) => request.command === 'longPress')?.body
      .commandId;
    assert.ok(commandId);
    assert.deepEqual(
      runner.requests
        .filter((request) => request.command === 'status')
        .map((request) => request.body.statusCommandId),
      [commandId, commandId],
    );
    assert.equal(session.commandCharges.hasOutstandingCharges, false);
  } finally {
    timerSpy.mockRestore();
    vi.useRealTimers();
    await runner.close();
  }
});
