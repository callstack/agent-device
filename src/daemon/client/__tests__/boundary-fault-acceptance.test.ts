import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonPaths } from '../../config.ts';
import type { DaemonRequest } from '../../types.ts';
import { sendRequest } from '../daemon-client-transport.ts';

const PROCESS_DEATH_COMMANDS = ['open', 'close'] as const;
const REQUIRED_PROCESS_DEATH_COMMANDS = ['open', 'close'] as const;

test('acceptance matrix declares both process-death lifecycle commands', () => {
  assert.deepEqual([...PROCESS_DEATH_COMMANDS].sort(), [...REQUIRED_PROCESS_DEATH_COMMANDS].sort());
});

test.each(PROCESS_DEATH_COMMANDS)(
  'acceptance row: process death after %s dispatch is a bounded, non-replayed request',
  async (command) => {
    // This acceptance row deliberately stops at the transport boundary: a
    // dead daemon is observed as a closed response socket. Lifecycle teardown
    // and process-tree cleanup belong to the deferred full fault matrix.
    const endpoint = await startEndpointThatDiesAfterRequest();
    const baseDir = mkdtempForTestSync(`agent-device-process-death-${command}-`);
    const statePaths = daemonPaths(baseDir);
    const request = buildRequest(command);

    try {
      await assert.rejects(
        sendRequest(
          { httpPort: endpoint.port, token: 'test-token', pid: process.pid },
          request,
          'http',
          statePaths,
          1_000,
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /communicate with daemon/i);
          assert.equal(error.details?.requestId, request.meta?.requestId);
          assert.match(String(error.details?.hint), /Retry command/i);
          return true;
        },
      );
    } finally {
      await endpoint.close();
    }

    assert.deepEqual(endpoint.commands, [command]);
  },
);

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
      // socket closing. There is no response and no safe retry path for either
      // lifecycle command.
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

function buildRequest(command: (typeof PROCESS_DEATH_COMMANDS)[number]): DaemonRequest {
  return {
    token: 'test-token',
    session: 'acceptance',
    command,
    positionals: command === 'open' ? ['Demo'] : [],
    flags: {},
    meta: { requestId: `acceptance-process-death-${command}` },
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
