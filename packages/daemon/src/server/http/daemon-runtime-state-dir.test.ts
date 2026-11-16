// Startup, not the first `open`, is what makes the daemon's own state chain private. Both are on the chain
// of every recording the daemon picks a path for, and the destination-ancestry rule refuses a group-writable
// directory on it (ADR 0016), so a state directory an older release left at 0775 has to be forced before a
// session is ever created.
// (https://github.com/callstack/agent-device/pull/4584)

import fs from 'node:fs';
import { expect, test } from 'vitest';
import {
  createTestHostEnvironment,
  FOREIGN_UID,
  mkdtempForTestSync,
  serveHostOwnership,
} from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError } from '@agent-device/kernel/errors';
import { SessionStore } from '../../core/session-store.ts';
import {
  authoringPublication,
  makeAuthoringSession,
} from '../../__tests__/support/session-factories.ts';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

const silent = { stderr: { write: () => {} }, stdout: { write: () => {} } };

test.skipIf(process.platform === 'win32')(
  'startup repairs a state chain a legacy release or a shared checkout left group-writable',
  async () => {
    // A host that ran an older version, or a checkout shared under the umask 002, stands at 0775. Nothing
    // else forces those levels: `sessions/` is created by a per-session `mkdir` at the mode the umask gives
    // it. Deleting the two `ensurePrivateDaemonStateDir` calls from startup turns this red.
    const stateDir = mkdtempForTestSync('agent-device-startup-state-');
    const { baseDir, sessionsDir } = resolveDaemonPaths(stateDir);
    fs.mkdirSync(sessionsDir, { mode: 0o755 });
    fs.chmodSync(baseDir, 0o775);
    fs.chmodSync(sessionsDir, 0o775);

    const runtime = await startDaemonRuntime({
      host: hostFor(stateDir),
      ...silent,
      composeDeps: daemonRuntimeDepsFixture({}),
    });
    try {
      expect(modeOf(baseDir)).toBe(0o700);
      expect(modeOf(sessionsDir)).toBe(0o700);

      // The point of the repair: a default recording walked through `sessions/` is now accepted. Before it,
      // every one of these was refused `script_ancestor_untrusted` / `shared_group_writable`.
      const store = new SessionStore(sessionsDir, createTestHostEnvironment());
      const written = store.writeSessionLog(
        store.publish(
          'journey',
          makeAuthoringSession('journey', {
            scriptPublication: authoringPublication('armed', {}),
            actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
          }),
        ),
      );
      if (!written.written)
        throw new Error(`startup left the chain untrusted: ${JSON.stringify(written)}`);
    } finally {
      await runtime.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'startup refuses state it may not force private, instead of changing another user files',
  async () => {
    // A `sessions` left owned by a different uid — the shape a machine sees when one user ran the daemon as
    // root — is refused with its mode intact. Forcing it would take a directory away from its owner.
    const stateDir = mkdtempForTestSync('agent-device-startup-state-foreign-');
    const { sessionsDir } = resolveDaemonPaths(stateDir);
    fs.mkdirSync(sessionsDir, { mode: 0o755 });
    fs.chmodSync(sessionsDir, 0o775);
    serveHostOwnership({ [sessionsDir]: FOREIGN_UID });

    const started = startDaemonRuntime({
      host: hostFor(stateDir),
      ...silent,
      composeDeps: daemonRuntimeDepsFixture({}),
    });

    expect(detailsOf(await started.catch((error: unknown) => error))).toMatchObject({
      reason: 'state_dir_foreign_owned',
      path: sessionsDir,
    });
    expect(modeOf(sessionsDir)).toBe(0o775);
  },
);

function hostFor(stateDir: string) {
  return createTestHostEnvironment({
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
  });
}

function modeOf(target: string): number {
  return Number(fs.lstatSync(target).mode & 0o777);
}

/** The typed details of the startup failure, so a refusal is read by its reason and never by its text. */
function detailsOf(error: unknown): Record<string, unknown> | undefined {
  return error instanceof AppError ? (error.details as Record<string, unknown>) : undefined;
}
