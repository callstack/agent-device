import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/index.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '../../../../utils/diagnostics.ts';
import { RUNNER_OWNER_START_TIME, type RunnerLease } from '../runner/runner-lease.ts';
import type { RunnerSession } from '../runner/runner-session-types.ts';

// Fabricated runner sessions, leases, background children, and transport
// payloads shared by the runner-session tests. The child pids here are made up
// (`4242`): nothing in a test may deliver a real signal to them, so the owning
// tests mock the signal seam in `src/utils/host-process.ts` — see
// `src/__tests__/hermetic-signal-setup.ts` and #1824.

export function makeRunnerSession(overrides: Partial<RunnerSession> = {}): RunnerSession {
  return {
    sessionId: `session-${overrides.port ?? 8100}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port: 8100,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    testPromise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    child: { pid: 1234, exitCode: null },
    ready: true,
    ...overrides,
  } as RunnerSession;
}

export function makeRunnerLease(
  overrides: Partial<RunnerLease> & { deviceId: string; ownerToken?: string | undefined },
): RunnerLease {
  const ownerToken = overrides.ownerToken ?? `owner-${process.pid}-test`;
  const lease: RunnerLease = {
    schemaVersion: 1,
    deviceId: overrides.deviceId,
    ownerToken,
    ownerPid: process.pid,
    ownerStartTime: RUNNER_OWNER_START_TIME,
    sessionId: `session-${overrides.deviceId}`,
    runnerPid: 4242,
    port: 8123,
    xctestrunPath: `/tmp/AgentDeviceRunner.env.session-${overrides.deviceId}-${ownerToken}-8123.xctestrun`,
    jsonPath: `/tmp/AgentDeviceRunner.env.session-${overrides.deviceId}-${ownerToken}-8123.json`,
    createdAtMs: Date.now(),
  };
  return { ...lease, ...overrides, ownerToken };
}

export function makeBackgroundRunner(pid: number) {
  return {
    child: {
      pid,
      exitCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    },
    wait: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  };
}

export function runnerResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, data }));
}

export function runnerError(error: { code: string; message: string }): Response {
  return new Response(JSON.stringify({ ok: false, error }));
}

export async function captureDiagnostics(callback: () => Promise<void>): Promise<string> {
  const previousHome = process.env.HOME;
  process.env.HOME = mkdtempForTestSync('agent-device-runner-diag-');
  try {
    return await withDiagnosticsScope(
      { session: 'runner-session-test', requestId: 'request-1', command: 'tap' },
      async () => {
        await callback();
        const diagnosticsPath = flushDiagnosticsToSessionFile({ force: true })?.path;
        assert.ok(diagnosticsPath);
        return fs.readFileSync(diagnosticsPath, 'utf8');
      },
    );
  } finally {
    process.env.HOME = previousHome;
  }
}

export function assertRunnerCommand(
  actual: unknown,
  expected: Record<string, unknown>,
  options: { commandId?: boolean } = {},
): asserts actual is Record<string, unknown> {
  assert.equal(typeof actual, 'object');
  assert.notEqual(actual, null);
  const command = actual as Record<string, unknown>;
  const commandId = command.commandId;
  if (options.commandId === false) {
    assert.equal(commandId, undefined);
    assert.deepEqual(command, expected);
    return;
  }
  if (typeof commandId !== 'string') {
    assert.fail('expected runner commandId');
  }
  assert.match(commandId, /^runner-/);
  assert.deepEqual({ ...command, commandId: undefined }, { ...expected, commandId: undefined });
}
