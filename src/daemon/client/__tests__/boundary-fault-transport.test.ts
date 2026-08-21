import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  listenOnLoopback,
  type LoopbackServer,
} from '../../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonPaths } from '../../config.ts';
import type { DaemonRequest } from '../../types.ts';
import { sendRequest } from '../daemon-client-transport.ts';

const { mockRunCmdSync } = vi.hoisted(() => ({ mockRunCmdSync: vi.fn() }));

vi.mock('../../../utils/exec.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../../utils/exec.ts')>('../../../utils/exec.ts');
  return { ...actual, runCmdSync: mockRunCmdSync };
});

const COMMAND_ROWS = {
  mutation: { command: PUBLIC_COMMANDS.press, positionals: ['enter'] },
  read: { command: PUBLIC_COMMANDS.snapshot, positionals: [] },
  'artifact-producing': {
    command: PUBLIC_COMMANDS.screenshot,
    positionals: ['/tmp/boundary-fault.png'],
  },
  'session-lifecycle': { command: PUBLIC_COMMANDS.open, positionals: ['Demo'] },
} as const;

const openServers: LoopbackServer[] = [];

beforeEach(() => {
  mockRunCmdSync.mockReset();
  mockRunCmdSync.mockReturnValue({ exitCode: 1, stdout: '', stderr: '' });
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeLoopbackServer));
});

for (const [commandClass, row] of Object.entries(COMMAND_ROWS)) {
  test(`HTTP timeout stays bounded for the ${commandClass} command class`, async () => {
    const endpoint = await startHttpServer((_request, _response) => {
      // Keep the accepted request open so the client's own deadline is the
      // only completion path.
    });
    const request = buildRequest(row, `timeout-${commandClass}`);

    await assert.rejects(
      sendRequest(
        { httpPort: endpoint.port, token: 'test-token', pid: process.pid },
        request,
        'http',
        daemonPaths(),
        60,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.message, 'Daemon request timed out');
        assert.equal(error.details?.timeoutMs, 60);
        assert.equal(error.details?.requestId, request.meta?.requestId);
        assert.equal(typeof normalizeError(error).hint, 'string');
        return true;
      },
    );
    assert.equal(mockRunCmdSync.mock.calls.filter(([command]) => command === 'pkill').length, 3);
  });

  for (const responseShape of ['partial', 'malformed'] as const) {
    test(`HTTP ${responseShape} response is typed for the ${commandClass} command class`, async () => {
      const endpoint = await startHttpServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        if (responseShape === 'partial') {
          response.end('{"jsonrpc":"2.0","result":');
        } else {
          response.end('{"jsonrpc":"2.0","result":null}');
        }
      });
      const request = buildRequest(row, `${responseShape}-${commandClass}`);

      await assert.rejects(
        sendRequest(
          { httpPort: endpoint.port, token: 'test-token', pid: process.pid },
          request,
          'http',
          daemonPaths(),
          1_000,
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /Invalid daemon/);
          assert.equal(error.details?.requestId, request.meta?.requestId);
          return true;
        },
      );
    });
  }
}

test('HTTP RPC errors preserve typed identity through the client transport', async () => {
  const endpoint = await startHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          message: 'device disappeared',
          data: {
            code: 'DEVICE_NOT_FOUND',
            message: 'device disappeared',
            hint: 'Reconnect the device and retry.',
            diagnosticId: 'diag-boundary-1',
            logPath: '/tmp/boundary-daemon.ndjson',
          },
        },
      }),
    );
  });
  const request = buildRequest(COMMAND_ROWS.read, 'typed-error');

  await assert.rejects(
    sendRequest(
      { httpPort: endpoint.port, token: 'test-token', pid: process.pid },
      request,
      'http',
      daemonPaths(),
      1_000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'DEVICE_NOT_FOUND');
      assert.equal(error.details?.hint, 'Reconnect the device and retry.');
      assert.equal(error.details?.diagnosticId, 'diag-boundary-1');
      assert.equal(error.details?.logPath, '/tmp/boundary-daemon.ndjson');
      assert.equal(error.details?.requestId, request.meta?.requestId);
      return true;
    },
  );
});

test('socket partial response fails at end-of-stream instead of waiting for the deadline', async () => {
  const endpoint = await startNetServer((socket) => {
    socket.once('data', () => {
      socket.end('{"ok":');
    });
  });
  const request = buildRequest(COMMAND_ROWS.read, 'socket-partial');
  const startedAt = Date.now();

  await assert.rejects(
    sendRequest(
      { port: endpoint.port, token: 'test-token', pid: process.pid },
      request,
      'socket',
      daemonPaths(),
      1_000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Invalid daemon response');
      assert.equal(error.details?.requestId, request.meta?.requestId);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 500, 'EOF should reject before the injected deadline');
});

test('socket empty response fails at end-of-stream with request context', async () => {
  const endpoint = await startNetServer((socket) => {
    socket.once('data', () => {
      socket.end();
    });
  });
  const request = buildRequest(COMMAND_ROWS.read, 'socket-empty');
  const startedAt = Date.now();

  await assert.rejects(
    sendRequest(
      { port: endpoint.port, token: 'test-token', pid: process.pid },
      request,
      'socket',
      daemonPaths(),
      1_000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Invalid daemon response');
      assert.equal(error.details?.requestId, request.meta?.requestId);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 500, 'EOF should reject before the injected deadline');
});

test('socket malformed response stays typed at the daemon client seam', async () => {
  const endpoint = await startNetServer((socket) => {
    socket.once('data', () => {
      socket.end('not-json\n');
    });
  });
  const request = buildRequest(COMMAND_ROWS.mutation, 'socket-malformed');

  await assert.rejects(
    sendRequest(
      { port: endpoint.port, token: 'test-token', pid: process.pid },
      request,
      'socket',
      daemonPaths(),
      1_000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Invalid daemon response');
      assert.equal(error.details?.requestId, request.meta?.requestId);
      return true;
    },
  );
});

function buildRequest(
  row: { command: string; positionals: readonly string[] },
  suffix: string,
): DaemonRequest {
  return {
    token: 'test-token',
    session: 'boundary-faults',
    command: row.command,
    positionals: [...row.positionals],
    flags: {},
    meta: { requestId: `boundary-${suffix}` },
  };
}

function daemonPaths(): DaemonPaths {
  const baseDir = mkdtempForTestSync('agent-device-boundary-transport-');
  return {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    sessionsDir: path.join(baseDir, 'sessions'),
  };
}

function startHttpServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ port: number }> {
  const server = http.createServer(handler);
  openServers.push(server);
  return listenOnLoopback(server).then((port) => ({ port }));
}

function startNetServer(handler: (socket: net.Socket) => void): Promise<{ port: number }> {
  const server = net.createServer(handler);
  openServers.push(server);
  return listenOnLoopback(server).then((port) => ({ port }));
}
