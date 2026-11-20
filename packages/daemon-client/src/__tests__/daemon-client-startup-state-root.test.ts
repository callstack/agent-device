import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import { sendToDaemon } from '../index.ts';

// Every local client route — the MCP server's ensured transport, the AI SDK tools, `createAgentDeviceClient`
// and the CLI — reaches the state directory through the one observation below. The CLI admits its root before
// it builds a client; these routes do not pass the CLI, so this is where their first state-directory read gets
// its one admission, and where #4649's planted link has to refuse.

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

test.skipIf(!posix)(
  'a local client refuses a planted link at its state root before reading the record behind it',
  async () => {
    const under = fs.realpathSync(mkdtempForTestSync('daemon-client-state-root-link-'));
    const target = path.join(under, 'outside');
    const stateDir = path.join(under, 'state');
    plantRegistration({ stateDir, target });
    const infoPath = path.join(target, 'daemon.json');

    // Two proofs that nothing reached the record: the read itself never happened, and no connection to the
    // daemon it names was attempted. A client that admitted nothing would do both.
    const reads: string[] = [];
    const realReadFileSync = fs.readFileSync as (name: fs.PathLike, ...rest: unknown[]) => unknown;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((name: fs.PathLike, ...rest: unknown[]) => {
      reads.push(String(name));
      return realReadFileSync(name, ...rest);
    }) as typeof fs.readFileSync);
    const connect = vi.spyOn(net, 'createConnection');

    const details = await refusalOf(() =>
      sendToDaemon({
        session: 'default',
        command: 'devices',
        positionals: [],
        flags: { stateDir, daemonTransport: 'http' as const },
        meta: { requestId: 'req-planted-state-root' },
      }),
    );

    assert.equal(details.reason, 'daemon_state_root_unsafe');
    assert.equal(details.problem, 'symlink');
    assert.equal(details.stateDir, stateDir);
    assert.ok(!reads.includes(infoPath), `the planted record was read: ${reads.join(', ')}`);
    assert.equal(connect.mock.calls.length, 0);
    // Nothing was written through the link either: the target holds only what the planter left.
    assert.deepEqual(fs.readdirSync(target).sort(), ['daemon.json']);
  },
);

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
