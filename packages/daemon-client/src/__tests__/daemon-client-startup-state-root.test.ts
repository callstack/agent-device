import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { readRegisteredDaemon, sendToDaemon } from '../index.ts';

// Every local client route — the MCP server's ensured transport, the AI SDK tools, `createAgentDeviceClient`
// and the CLI — reads the state directory in `readRegisteredDaemon`, and that export is a public surface on its
// own. The CLI admits its root before it builds a client; these routes do not pass the CLI, so that reader is
// where their first state-directory read gets its one admission, and where #4649's planted link has to refuse.

const posix = process.platform !== 'win32';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A record an outside account planted: its pid, port and token are the ones a client must never trust. */
function plantRegistration(options: { stateDir: string; target: string }): void {
  fs.mkdirSync(options.target, { mode: 0o700 });
  fs.writeFileSync(
    path.join(options.target, 'daemon.json'),
    `${JSON.stringify({ pid: 4242, port: 42424, httpPort: 42424, token: 'token-of-another-account' })}\n`,
  );
  fs.symlinkSync(options.target, options.stateDir);
}

function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  return run().then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      return (error as AppError).details as Record<string, unknown>;
    },
  );
}

/**
 * Everything the client would have to touch in order to read the registration: the spelled `stateDir` paths it
 * names, and each transport it would reach the daemon over. The admission walks the ROOT's own name, so these
 * two paths are what only a real read of the registration explains.
 */
function watchRegistrationReads(paths: DaemonPaths): {
  stateReads: string[];
  socketAttempts: () => number;
  httpAttempts: () => string[];
} {
  const watched = [paths.infoPath, paths.lockPath];
  const stateReads: string[] = [];
  for (const name of [
    'readFileSync',
    'openSync',
    'lstatSync',
    'statSync',
    'existsSync',
    'readdirSync',
  ] as const) {
    const real = fs[name] as (target: fs.PathLike, ...rest: unknown[]) => unknown;
    vi.spyOn(fs, name).mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      const spelled = String(target);
      if (
        watched.some(
          (pathName) => spelled === pathName || spelled.startsWith(`${pathName}${path.sep}`),
        )
      )
        stateReads.push(`${name}:${spelled}`);
      return real(target, ...rest);
    }) as never);
  }
  const sockets = vi.spyOn(net, 'createConnection');
  const requests: string[] = [];
  vi.spyOn(httpModule, 'request').mockImplementation(((...args: unknown[]) => {
    requests.push(JSON.stringify(args[0] ?? null));
    return httpProbeRefused();
  }) as unknown as typeof httpModule.request);
  return {
    stateReads,
    socketAttempts: () => sockets.mock.calls.length,
    httpAttempts: () => requests,
  };
}

// `node:http` is loaded on demand by the transport, and `loadNodeHttpRequester` resolves the very same module
// object, so this is the `request` property a real HTTP probe goes through. It answers nothing: a client that
// got this far never read a registration it was allowed to trust.
const httpModule = (await import('node:http')).default;

function httpProbeRefused(): never {
  throw new Error('the client reached an HTTP probe');
}

// Both transports, because a planted record names a socket port AND an HTTP port, and a client that read it
// would probe whichever the request prefers.
for (const daemonTransport of ['socket', 'http'] as const) {
  test.skipIf(!posix)(
    `a local client refuses a planted link at its state root before reading the record behind it (${daemonTransport})`,
    async () => {
      const under = fs.realpathSync(mkdtempForTestSync('daemon-client-state-root-link-'));
      const target = path.join(under, 'outside');
      const stateDir = path.join(under, 'state');
      plantRegistration({ stateDir, target });
      const paths = resolveDaemonPaths(stateDir);
      const watched = watchRegistrationReads(paths);

      const details = await refusalOf(() =>
        sendToDaemon({
          session: 'default',
          command: 'devices',
          positionals: [],
          flags: { stateDir, daemonTransport },
          meta: { requestId: `req-planted-state-root-${daemonTransport}` },
        }),
      );

      // The record behind the link, and the lock beside it, were never opened on the spelled route.
      assert.deepEqual(watched.stateReads, []);
      assert.equal(watched.socketAttempts(), 0);
      assert.deepEqual(watched.httpAttempts(), []);
      assert.equal(details.reason, 'daemon_state_root_unsafe');
      assert.equal(details.problem, 'symlink');
      assert.equal(details.stateDir, stateDir);
      // Nothing was written through the link either: the target holds only what the planter left.
      assert.deepEqual(fs.readdirSync(target).sort(), ['daemon.json']);
    },
  );
}

test.skipIf(!posix)(
  'a client refuses a state root another account owns before it reads the record there',
  async () => {
    const under = fs.realpathSync(mkdtempForTestSync('daemon-client-state-root-foreign-'));
    const stateDir = path.join(under, 'state');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'daemon.json'), '{"pid":1}\n');
    // An unprivileged test process cannot `chown`, so the id moves at the `lstat` seam the rule reads.
    serveHostOwnership({ [stateDir]: FOREIGN_UID });

    const details = await refusalOf(() =>
      sendToDaemon({
        session: 'default',
        command: 'devices',
        positionals: [],
        flags: { stateDir, daemonTransport: 'http' as const },
        meta: { requestId: 'req-foreign-state-root' },
      }),
    );

    assert.equal(details.reason, 'daemon_state_root_unsafe');
    assert.equal(details.problem, 'foreign-owner');
  },
);

// What a remembered verdict would have cost: an absent root is admitted, because a client creates nothing, and
// an account that can write the parent puts a link there before the next read. A long-lived MCP server hits
// exactly this, so every read walks again and the second one refuses (#4649).
test.skipIf(!posix)(
  'a client that admitted an absent root refuses a link planted at it before its next read',
  async () => {
    const under = fs.realpathSync(mkdtempForTestSync('daemon-client-state-root-planted-later-'));
    const stateDir = path.join(under, 'state');
    const paths = resolveDaemonPaths(stateDir);

    // The first read has nothing to refuse: no root, so no daemon, and nothing is created.
    assert.equal(await readRegisteredDaemon(paths), null);
    assert.equal(fs.existsSync(stateDir), false);

    plantRegistration({ stateDir, target: path.join(under, 'outside') });
    const details = await refusalOf(() => readRegisteredDaemon(paths));

    assert.equal(details.reason, 'daemon_state_root_unsafe');
    assert.equal(details.problem, 'symlink');
    assert.equal(details.stateDir, stateDir);
  },
);
