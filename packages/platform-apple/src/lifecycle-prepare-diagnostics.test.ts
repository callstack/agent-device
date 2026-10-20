import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { coldSimulatorLifecycleHost, simulator } from './lifecycle.fixtures.ts';

for (const failed of [false, true]) {
  test(`prepare retains readiness and inventory phase boundaries on ${failed ? 'failure' : 'success'}`, async () => {
    const { host, prepareRunner } = coldSimulatorLifecycleHost();
    const failure = new AppError('COMMAND_FAILED', 'fixture timeout', { timeoutMs: 15_000 });
    if (failed) vi.mocked(host.appleTools.run).mockRejectedValueOnce(failure);
    const logPath = path.join(mkdtempForTestSync('prepare-phases-'), 'request.ndjson');
    await withDiagnosticsScope(
      { requestId: 'prepare', logPath, flushOnSuccess: true },
      async () => {
        const operation = bindAppleApplicationLifecycle({
          host,
          device: simulator,
          signal: new AbortController().signal,
        }).prepareAppleRunner({ timeoutMs: 100_000, execution: {} });
        if (failed) await expect(operation).rejects.toBe(failure);
        else await operation;
        flushDiagnosticsToSessionFile();
      },
    );
    const rows = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => [row.phase, row.data.event])).toEqual([
      ['prepare_apple_runner', 'readiness_start'],
      ['simulator_state', 'start'],
      ['simulator_state', 'settled'],
      ...(!failed ? [['prepare_apple_runner', 'runner_start']] : []),
      ['prepare_apple_runner', 'settled'],
    ]);
    expect(
      rows
        .filter((row) => row.phase === 'simulator_state')
        .every((row) => row.data.timeoutMs === 15_000),
    ).toBe(true);
    expect(prepareRunner).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(rows.at(-1).durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[0].data.remainingMs).toBeGreaterThan(0);
  });
}
