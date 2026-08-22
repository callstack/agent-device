import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { assertRejectsAppError } from '../../../__tests__/test-utils/app-error.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonPaths } from '../../config.ts';
import type { DaemonRequest } from '../../types.ts';
import { sendRequest } from '../daemon-client-transport.ts';

type ProcessDeathCommand = 'press' | 'fill' | 'snapshot' | 'screenshot' | 'open' | 'close';
type ProcessDeathRow = Readonly<{
  command: ProcessDeathCommand;
  positionals: readonly string[];
}>;

const PROCESS_DEATH_ROWS = {
  press: { command: 'press', positionals: ['enter'] },
  fill: { command: 'fill', positionals: ['@e1', 'Ada'] },
  snapshot: { command: 'snapshot', positionals: [] },
  screenshot: { command: 'screenshot', positionals: ['/tmp/acceptance.png'] },
  open: { command: 'open', positionals: ['Demo'] },
  close: { command: 'close', positionals: [] },
} as const satisfies Record<ProcessDeathCommand, ProcessDeathRow>;

for (const row of Object.values(PROCESS_DEATH_ROWS)) {
  test(`acceptance row: process death after ${row.command} dispatch is bounded and non-replayed`, async () => {
    // A dead daemon is observed as a closed response socket. The command is
    // sent exactly once because the transport cannot establish whether the
    // daemon applied it before dying.
    const endpoint = await startEndpointThatDiesAfterRequest();
    const baseDir = mkdtempForTestSync(`agent-device-process-death-${row.command}-`);
    const statePaths = daemonPaths(baseDir);
    const request = buildRequest(row);
    let observed: unknown;

    try {
      await assertRejectsAppError(
        async () => {
          try {
            return await sendRequest(
              { httpPort: endpoint.port, token: 'test-token', pid: process.pid },
              request,
              'http',
              statePaths,
              1_000,
            );
          } catch (error) {
            observed = error;
            throw error;
          }
        },
        {
          code: 'COMMAND_FAILED',
          message: /communicate with daemon/i,
          hint: /Retry command/i,
        },
      );
    } finally {
      await endpoint.close();
    }

    assert.ok(observed instanceof AppError);
    assert.equal(observed.details?.requestId, request.meta?.requestId);
    assert.deepEqual(endpoint.commands, [row.command]);
  });
}

type DeadEndpoint = {
  port: number;
  commands: string[];
  close: () => Promise<void>;
};

async function startEndpointThatDiesAfterRequest(): Promise<DeadEndpoint> {
  const commands: string[] = [];
  let closePromise: Promise<void> | undefined;
  const server = http.createServer((request) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { params?: { command?: unknown } };
      const command = parsed.params?.command;
      if (typeof command === 'string') commands.push(command);
      // A daemon process death after dispatch is observed as the accepted
      // socket closing. There is no response and no safe retry path after any
      // command has crossed the dispatch boundary.
      request.socket.destroy();
      closePromise ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    port: address.port,
    commands,
    close: async () => {
      if (!closePromise) {
        closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await closePromise;
    },
  };
}

function buildRequest(row: ProcessDeathRow): DaemonRequest {
  return {
    token: 'test-token',
    session: 'acceptance',
    command: row.command,
    positionals: [...row.positionals],
    flags: {},
    meta: { requestId: `acceptance-process-death-${row.command}` },
  };
}

function daemonPaths(baseDir: string): DaemonPaths {
  return {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    sessionsDir: path.join(baseDir, 'sessions'),
  };
}
