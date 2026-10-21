import assert from 'node:assert/strict';
import type { ExecResult } from '@agent-device/host-kit/command';
import { getRequestSignal, withRequestDeadline } from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import { executeRunnerExchange } from '../../../packages/platform-apple/src/runner/runner-exchange.ts';
import {
  RunnerCommandAccounting,
  type RunnerSession,
} from '../../../packages/platform-apple/src/runner/runner-session-types.ts';
import { IOS_SIMULATOR } from '../../../packages/platform-apple/src/runner/__tests__/device-fixtures.ts';
import { startFakeRunnerServer } from '../../../packages/platform-apple/src/runner/__tests__/fake-runner-server.ts';
import {
  installAppleRunnerTestHost,
  loadAppleRunnerHost,
} from '../../../packages/platform-apple/src/runner/test-host.ts';
import { test } from 'vitest';

test('a daemon deadline follows the ordinary canceled Apple runner journal drain', async () => {
  installAppleRunnerTestHost(await loadAppleRunnerHost());
  const runner = await startFakeRunnerServer({
    longPress: [{ kind: 'hold' }],
    status: [
      { kind: 'ok', data: { lifecycleState: 'started' } },
      { kind: 'ok', data: { lifecycleState: 'completed' } },
    ],
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

    await assert.rejects(
      withRequestDeadline(requestId, 25, async () => {
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
      }),
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
    await runner.close();
  }
});
