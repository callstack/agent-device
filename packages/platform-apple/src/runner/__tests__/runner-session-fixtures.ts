import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { runnerOwnerStartTime, type RunnerLease } from '../runner-lease.ts';
import type { RunnerSession } from '../runner-session-types.ts';

// Fabricated runner sessions, leases, background children, and transport
// payloads shared by the runner-session tests. The child pids here are made up
// (`4242`): nothing in a test may deliver a real signal to them, so the owning
// tests mock the signal seam in `@agent-device/host-kit/process` — see
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
    ownerStartTime: runnerOwnerStartTime(),
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

// Records everything the runner package emits through host.emitDiagnostic /
// host.withDiagnosticTimer during `callback` and renders it back as the same
// newline-delimited-JSON shape a flushed diagnostics session file holds, so
// callers can `assert.match` against phase names and payload fields exactly
// as before the move. `withDiagnosticTimer`'s real default still runs `fn`
// (R7) but emits through the untestable module-local diagnostics scope, so
// it is overridden here too rather than left on the real default.
export async function captureDiagnostics(callback: () => Promise<void>): Promise<string> {
  const events: Record<string, unknown>[] = [];
  appleRunnerTestHost.update({
    emitDiagnostic: (event) => {
      events.push({ level: event.level ?? 'info', phase: event.phase, data: event.data });
    },
    withDiagnosticTimer: async (phase, fn, data) => {
      const start = Date.now();
      try {
        const result = await fn();
        events.push({ level: 'info', phase, durationMs: Date.now() - start, data });
        return result;
      } catch (error) {
        events.push({
          level: 'error',
          phase,
          durationMs: Date.now() - start,
          data: { ...(data ?? {}), error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
    },
  });
  await callback();
  const diagnostics = events.map((event) => JSON.stringify(event)).join('\n');
  assert.ok(diagnostics.length > 0, 'expected at least one diagnostic event');
  return diagnostics;
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

// Root-registry writer (`request/cancel.ts`) is not visible to the package;
// this reproduces the canceled-request-id state locally so suites back the
// host's read-only `isRequestCanceled` with it while keeping the original
// markRequestCanceled/clearRequestCanceled call-site names and semantics.
export function createTestRequestCancellation(): {
  markRequestCanceled(requestId: string | undefined): void;
  clearRequestCanceled(requestId: string | undefined): void;
  isRequestCanceled(requestId: string | undefined): boolean;
  reset(): void;
} {
  const canceledRequestIds = new Set<string>();
  return {
    markRequestCanceled: (requestId) => void (requestId && canceledRequestIds.add(requestId)),
    clearRequestCanceled: (requestId) => void (requestId && canceledRequestIds.delete(requestId)),
    isRequestCanceled: (requestId) => requestId !== undefined && canceledRequestIds.has(requestId),
    reset: () => canceledRequestIds.clear(),
  };
}

type OwnerLivenessVerdict =
  | 'live'
  | 'owner-process-dead'
  | 'owner-process-reused'
  | 'owner-state-dir-gone'
  | 'unknown';

// classifyOwnerLiveness's real default (@agent-device/host-kit/process) calls its
// OWN direct imports of isProcessAlive/readProcessStartTime rather than going
// through the package host, so overriding those two host slots does not reach
// it. This double is built over the SAME mocks a suite configures for them, so
// owner liveness stays consistent with the rest of the faked process table.
// Zombie detection is intentionally omitted: no package test depends on it,
// and it is not an overridable host slot.
export function makeClassifyOwnerLivenessViaMocks(deps: {
  isProcessAlive(pid: number): boolean;
  readProcessStartTime(pid: number): string | null;
}): (params: {
  owner: { pid: number; startTime: string | null };
  stateDir?: string;
}) => OwnerLivenessVerdict {
  const classifyStateDir = (stateDir: string): OwnerLivenessVerdict => {
    try {
      fs.statSync(stateDir);
      return 'live';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'owner-state-dir-gone' : 'unknown';
    }
  };
  return ({ owner, stateDir }) => {
    if (!deps.isProcessAlive(owner.pid)) return 'owner-process-dead';
    const currentStartTime = owner.startTime ? deps.readProcessStartTime(owner.pid) : null;
    if (owner.startTime && currentStartTime !== null && currentStartTime !== owner.startTime) {
      return 'owner-process-reused';
    }
    return stateDir ? classifyStateDir(stateDir) : 'live';
  };
}
