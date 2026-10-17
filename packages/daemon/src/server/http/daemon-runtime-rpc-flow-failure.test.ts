import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';

// The HTTP server hands a `/rpc` flow rejection it answered itself to `onUnownedRequestFailure`,
// because that event has no request scope to be recorded in — the request's own scope opens later,
// inside the handler. The runtime owns the pair every other out-of-request daemon event uses, so
// this boots the real runtime and checks both halves of what `openDaemonServers` wires: the
// injected error stream and the daemon log. The daemon's own HTTP route drives it, so a flow that
// stops answering shows up as a refused call rather than a hung one.
const requestProbe = vi.hoisted(() => ({
  // How many upcoming dispatches fail with an unreadable reason.
  failuresRemaining: 0,
}));

vi.mock('../request-router.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../request-router.ts')>();
  return {
    ...actual,
    createRequestHandler: (...args: Parameters<typeof actual.createRequestHandler>) => {
      const dispatch = actual.createRequestHandler(...args);
      return async (request: Parameters<typeof dispatch>[0]) => {
        if (requestProbe.failuresRemaining > 0) {
          requestProbe.failuresRemaining -= 1;
          throw unwrappableReason();
        }
        return await dispatch(request);
      };
    },
  };
});

import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  requestProbe.failuresRemaining = 0;
});

test('a /rpc flow failure the server refused itself reaches the runtime stderr and daemon log', async () => {
  const observed = await driveFlowFailure({});
  expect(observed.answer.status).toBe(500);
  expect(observed.answer.body.id).toBeNull();
  expect(observed.answer.body.error?.code).toBe(-32000);

  // The runtime's injected stream and not the process's: this is the channel the
  // `unhandledRejection` handler uses, and a daemon-level event belongs on that one.
  expect(observed.stderrLines.filter((line) => line.startsWith('Daemon error:'))).toEqual([
    'Daemon error: Unknown error\n',
  ]);
  expect(observed.events).toHaveLength(1);
  expect(observed.events[0]?.data).toEqual({ code: 'UNKNOWN', message: 'Unknown error' });
  expect(observed.rejections).toEqual([]);
  expect(observed.exitCode).toBeUndefined();
  expect(observed.nextCall).toEqual({ status: 400, code: -32600 });
});

// The record is written before the stream: an injected stderr that throws on write (a closed pipe,
// a daemon whose parent stopped reading) must not cost `daemon.log` the event, and the client must
// still get its refusal.
test('a /rpc flow failure still reaches daemon.log when the injected stderr throws', async () => {
  const observed = await driveFlowFailure({ stderrThrows: true });
  expect(observed.answer.status).toBe(500);
  expect(observed.answer.body.id).toBeNull();
  expect(observed.events).toHaveLength(1);
  expect(observed.events[0]?.phase).toBe('daemon_rpc_request_flow_failed');
  expect(observed.stderrLines).toEqual([]);
  expect(observed.rejections).toEqual([]);
  expect(observed.exitCode).toBeUndefined();
});

type FlowFailure = {
  answer: { status: number; body: { id?: unknown; error?: { code?: number } } };
  nextCall: { status: number; code: number | undefined };
  events: Array<{ phase: string; data?: Record<string, unknown> }>;
  stderrLines: string[];
  rejections: unknown[];
  exitCode: number | undefined;
};

/**
 * Boots the real runtime, fails one dispatch with an unreadable reason, and reports everything the
 * daemon produced for it. The refusal is answered synchronously while its record is written by the
 * detached report the server was handed, so the log line follows the answer by a turn.
 */
async function driveFlowFailure(options: { stderrThrows?: boolean }): Promise<FlowFailure> {
  const stateDir = mkdtempForTestSync('agent-device-daemon-rpc-flow-failure-');
  const paths = resolveDaemonPaths(stateDir);
  const stderrLines: string[] = [];
  // Records the reason without inspecting it: this one throws on the property read an assertion
  // would perform.
  const rejections: unknown[] = [];
  const observeRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  let exitCode: number | undefined;
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> = null;
  try {
    runtime = await startDaemonRuntime({
      composeDeps: daemonRuntimeDepsFixture(),
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        },
      }),
      exit: (code) => {
        exitCode = code;
      },
      registerProcessHandlers: false,
      stderr: {
        write: (chunk: string) => {
          if (options.stderrThrows) throw new Error('the stream is gone');
          stderrLines.push(chunk);
        },
      },
      stdout: { write: () => {} },
    });
    // Registered once the runtime is listening: a startup throw must not leave the listener on the
    // process for the rest of the worker.
    process.on('unhandledRejection', observeRejection);
    expect(runtime).not.toBeNull();
    const { httpPort, token } = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
      httpPort: number;
      token: string;
    };

    requestProbe.failuresRemaining = 1;
    const answer = await postRpc(httpPort, token, {
      jsonrpc: '2.0',
      id: 'req-flow-failure',
      method: 'agent_device.command',
      params: { command: 'session_list', meta: { requestId: 'req-flow-failure' } },
    });
    const events = await waitForDaemonLogEvent(paths.logPath, 'daemon_rpc_request_flow_failed');
    const next = await postRpc(httpPort, token, 'null');
    return {
      answer,
      nextCall: { status: next.status, code: next.body.error?.code },
      events,
      stderrLines,
      rejections,
      exitCode,
    };
  } finally {
    process.off('unhandledRejection', observeRejection);
    // Idle reaping is disabled here, so the runtime would otherwise keep an HTTP listener and a
    // forked Vitest worker alive. The state directory needs no cleanup: it lives under the per-run
    // TMPDIR Vitest removes.
    await runtime?.shutdown();
  }
}

async function postRpc(
  httpPort: number,
  token: string,
  body: unknown,
): Promise<{ status: number; body: { id?: unknown; error?: { code?: number } } }> {
  const response = await fetch(`http://127.0.0.1:${httpPort}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function waitForDaemonLogEvent(
  logPath: string,
  phase: string,
): Promise<Array<{ phase: string; data?: Record<string, unknown> }>> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const events = readDaemonLogEvents(logPath);
    if (events.some((event) => event.phase === phase) || Date.now() >= deadline) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readDaemonLogEvents(
  logPath: string,
): Array<{ phase: string; data?: Record<string, unknown> }> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> });
}

/**
 * A rejection reason that cannot be inspected: the one property `normalizeError` must read to
 * redact its diagnostics throws the reason itself, so the flow's own catches fail while computing
 * their answer and the failure reaches the runtime's sink unreadable — the shape a daemon-level
 * record has to survive. It stays printable, so a run without the guard reports the escaped
 * rejection instead of failing to format it.
 */
function unwrappableReason(): Record<string, unknown> {
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, 'details', {
    enumerable: true,
    get(): never {
      throw hostile;
    },
  });
  return hostile;
}
