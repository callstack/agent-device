import http from 'node:http';
import net from 'node:net';
import { vi, type Mock } from 'vitest';
import { listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';
import {
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
} from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import { currentDaemonCodeSignature } from '../../__tests__/test-utils/daemon-http-fixture.ts';

// Stand-ins for the daemons the explicit lifecycle judges: a loopback server that answers every
// `/rpc` with one scripted result, and a real child process that owns its registration.

export type ScriptedDaemon = {
  server: http.Server;
  port: number;
  rpcCommands: string[];
  rpcRequests: Record<string, any>[];
};

/**
 * What a daemon does once it has answered a quiesce with `draining`: it leaves by itself, running
 * its own registration cleanup. The registered child stands in for the daemon process, so
 * `leave` makes it exit the way a finished drain does, without the client signaling anything.
 */
export function createDaemonLeaver(): {
  pid?: number;
  leave: () => void;
  /** Signals the code under test sent to the daemon; the leaver's own exit is not among them. */
  clientSignals: Array<NodeJS.Signals | number>;
} {
  const actualKill = process.kill.bind(process);
  let leaving = false;
  const leaver: ReturnType<typeof createDaemonLeaver> = {
    clientSignals: [],
    leave: () => {
      if (leaver.pid === undefined) return;
      leaving = true;
      actualKill(leaver.pid, 'SIGTERM');
      leaving = false;
    },
  };
  vi.spyOn(process, 'kill').mockImplementation(((
    target: number,
    signal?: NodeJS.Signals | number,
  ) => {
    if (!leaving && target === leaver.pid && signal !== undefined && signal !== 0) {
      leaver.clientSignals.push(signal);
    }
    return actualKill(target, signal ?? 'SIGTERM');
  }) as typeof process.kill);
  return leaver;
}

/** Answers `/health` and answers every `/rpc` with the one JSON-RPC `result` it was given. */
export async function startScriptedDaemon(
  result: Record<string, unknown>,
  options: { afterRpc?: () => void } = {},
): Promise<ScriptedDaemon> {
  const rpcCommands: string[] = [];
  const rpcRequests: Record<string, any>[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
      rpcRequests.push(rpc);
      rpcCommands.push(String(rpc.params?.command));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), () => options.afterRpc?.());
    });
  });
  return { server, port: await listenOnLoopback(server), rpcCommands, rpcRequests };
}

/** A socket-only stand-in: one JSON line in, the scripted response out. */
export async function startScriptedSocketDaemon(
  response: Record<string, unknown>,
  options: { afterCommand?: () => void } = {},
): Promise<{ server: net.Server; port: number; commands: string[] }> {
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      commands.push(String((JSON.parse(buffered) as { command?: unknown }).command));
      socket.write(`${JSON.stringify(response)}\n`, () => options.afterCommand?.());
    });
  });
  return { server, port: await listenOnLoopback(server), commands };
}

export const okResult = (data: Record<string, unknown>) => ({ ok: true, data });
export const draining = okResult({ outcome: 'draining' });
export const busy = (census: Record<string, number>) => ({
  ok: false,
  error: {
    code: 'COMMAND_FAILED',
    message: 'Daemon is busy and was not asked to leave.',
    details: { reason: 'daemon-busy', ...census },
  },
});

export function stateDirAndPaths(): { stateDir: string; paths: DaemonPaths } {
  const stateDir = mkdtempForTestSync('agent-device-explicit-lifecycle-');
  return { stateDir, paths: resolveDaemonPaths(stateDir) };
}

type Registration = {
  httpPort?: number;
  socketPort?: number;
  version?: string;
  capabilities?: readonly string[];
};

/** A live child owning the registration, advertising `fields` at the stand-in's port. */
export async function registerDaemon(paths: DaemonPaths, fields: Registration) {
  const child = spawnRegisteredDaemonFixture(
    paths,
    {
      ...(fields.httpPort !== undefined ? { httpPort: fields.httpPort } : {}),
      ...(fields.socketPort !== undefined ? { socketPort: fields.socketPort } : {}),
      token: 'local-secret',
      version: fields.version ?? readVersion(),
      codeOrigin: 'checkout',
      codeSignature: currentDaemonCodeSignature(),
      ...(fields.capabilities ? { capabilities: fields.capabilities as ['quiesce'] } : {}),
    },
    undefined,
  );
  return { child, info: await waitForRegisteredDaemonFixture(paths, child) };
}

/**
 * Answers the daemon launch seam with a child that registers and advertises the stand-in at
 * `httpPort`, so a start the client performs yields a daemon it can reach.
 */
export function launchesFreshDaemonAt(
  spawn: Mock<typeof runCmdDetachedMonitored>,
  paths: DaemonPaths,
  httpPort: number,
): void {
  spawn.mockImplementation((_command, _args, options) =>
    spawnRegisteredDaemonFixture(
      paths,
      {
        httpPort,
        token: 'local-secret',
        version: readVersion(),
        codeOrigin: 'checkout',
        codeSignature: currentDaemonCodeSignature(),
        capabilities: ['quiesce'],
      },
      options,
    ),
  );
}
