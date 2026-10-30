import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecResult, ExecStreamOptions } from '@agent-device/host-kit/command';
import { createRunnerPhaseBudget, ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import { MACOS_DEVICE } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

/**
 * The build phase spends one budget (#2422). The cache decision reads the toolchain from files
 * before `xcodebuild` starts, so it spends none of that budget.
 */

/** The phase clock stands still, so the build is handed exactly the budget the phase left it. */
const clock = { nowMs: 0 };
const runCmdStreaming = vi.fn();
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempForTestSync('agent-device-runner-phase-root-');
  // `buildXctestrunArtifact` refuses to start a build without the runner project.
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = mkdtempForTestSync(
    'agent-device-runner-phase-derived-',
  );
  runCmdStreaming
    .mockReset()
    .mockImplementation(async (): Promise<ExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }));
  appleRunnerTestHost.update({
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
    deadlineFromTimeoutMs: (timeoutMs: number) => {
      const startedAtMs = clock.nowMs;
      const expiresAtMs = startedAtMs + Math.max(0, timeoutMs);
      return {
        remainingMs: () => Math.max(0, expiresAtMs - clock.nowMs),
        elapsedMs: () => Math.max(0, clock.nowMs - startedAtMs),
        isExpired: () => expiresAtMs - clock.nowMs <= 0,
      };
    },
  });
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
});

test('the cache decision leaves the build the whole phase budget', async () => {
  await assert.rejects(
    ensureXctestrunArtifact(MACOS_DEVICE, { budget: createRunnerPhaseBudget(120_000, undefined) }),
    (error: unknown) =>
      error instanceof AppError && error.message === 'Failed to locate .xctestrun after build',
  );

  assert.equal(runCmdStreaming.mock.calls.length, 1);
  const [command, , options] = runCmdStreaming.mock.calls[0] as [
    string,
    string[],
    ExecStreamOptions,
  ];
  assert.equal(command, 'xcodebuild');
  assert.equal(options.timeoutMs, 120_000);
});
