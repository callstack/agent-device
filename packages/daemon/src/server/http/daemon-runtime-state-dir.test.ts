// Startup, not the first `open`, is what makes the daemon's own state chain private. Both are on the chain
// of every recording the daemon picks a path for, and the destination-ancestry rule refuses a group-writable
// directory on it (ADR 0016), so a state directory an older release left at 0775 has to be forced before a
// session is ever created. What startup may NOT do is refuse a level whose mode it may not force: that
// decision belongs to the walk, per recording, and a host whose state it does not own still gets a daemon.
// (https://github.com/callstack/agent-device/pull/4584)

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  createTestHostEnvironment,
  FOREIGN_UID,
  mkdtempForTestSync,
  serveHostOwnership,
} from '@agent-device/test-kit';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { SessionStore } from '../../core/session-store.ts';
import {
  authoringPublication,
  makeAuthoringSession,
} from '../../__tests__/support/session-factories.ts';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import type { DaemonRuntimeDepsInput } from './daemon-runtime-deps.ts';
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
  'startup starts on state another user owns, warns, and refuses only the recording under it',
  async () => {
    // A `sessions/` owned by a different uid at 0755 — a container whose volume belongs to the uid the mount
    // came with, or a machine where one user ran the daemon as root — logged `daemon_state_mode_repair_skipped`
    // and started. Refusing to start here would fail EVERY command over a mode, and the daemon takes nothing
    // it does not own either way: the walk is what refuses a recording under that tree, with its own reason.
    const stateDir = fs.realpathSync(mkdtempForTestSync('agent-device-startup-state-foreign-'));
    const { sessionsDir } = resolveDaemonPaths(stateDir);
    fs.mkdirSync(sessionsDir, { mode: 0o755 });
    fs.chmodSync(sessionsDir, 0o755);
    serveHostOwnership({ [sessionsDir]: FOREIGN_UID });

    // The scope is only there to see the warning; the runtime is closed inside it, so nothing outlives it.
    const { runtime, skipped } = await withDiagnosticsScope({ session: 'daemon' }, async () => ({
      runtime: await startDaemonRuntime({
        host: hostFor(stateDir),
        ...silent,
        composeDeps: daemonRuntimeDepsFixture({}),
      }),
      skipped: countDiagnosticEventsByPhase(['daemon_state_mode_repair_skipped']),
    }));
    try {
      expect(skipped).toBe(1);
      // Nothing was taken from the owner: the directory stands as they left it.
      expect(modeOf(sessionsDir)).toBe(0o755);

      // The refusal the host DOES get names the daemon's own state chain: a default recording is a path the
      // daemon picks for itself, and it writes one only on ground it established as its own. The destination
      // walk is what refuses a CALLER's path; here the chain never reached the walk (ADR 0016).
      const store = new SessionStore(sessionsDir, createTestHostEnvironment());
      const refused = store.writeSessionLog(
        store.publish(
          'journey',
          makeAuthoringSession('journey', {
            scriptPublication: authoringPublication('armed', {}),
            actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
          }),
        ),
      );
      expect(refusalOf(refused)).toMatchObject({ reason: 'state_chain_untrusted' });
      expect(String(refusalOf(refused).path).startsWith(sessionsDir + path.sep)).toBe(true);
      // This host shape is what the hint has to name: this uid is not the owner of that tree, and the two
      // ways out are chown and AGENT_DEVICE_STATE_DIR.
      expect(String(refusalOf(refused).hint)).toContain('chown');
      expect(String(refusalOf(refused).hint)).toContain('AGENT_DEVICE_STATE_DIR');
      // Nothing was written under the foreign directory.
      expect(fs.readdirSync(sessionsDir)).toEqual([]);
    } finally {
      await runtime.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'startup starts when the state directory is a link, and leaves where it leads alone',
  async () => {
    // The other setup that must keep starting: `~/.agent-device` linked to another disk. The repair will not
    // force a mode through a name that resolves somewhere else, so it skips that level with a warning — and
    // the daemon still uses the state where the link points, exactly as it did before this rule existed.
    const target = mkdtempForTestSync('agent-device-startup-state-target-');
    const parent = mkdtempForTestSync('agent-device-startup-state-link-');
    const linked = path.join(parent, 'state');
    fs.symlinkSync(target, linked);

    const { runtime, skipped } = await withDiagnosticsScope({ session: 'daemon' }, async () => ({
      runtime: await startDaemonRuntime({
        host: hostFor(linked),
        ...silent,
        composeDeps: daemonRuntimeDepsFixture({}),
      }),
      skipped: countDiagnosticEventsByPhase(['daemon_state_mode_repair_skipped']),
    }));
    try {
      // The repair skipped the levels it could not reach by descriptor, and changed nothing else: the link is
      // still a link and the state appeared under the directory it points at.
      expect(skipped).toBeGreaterThanOrEqual(1);
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(target, 'sessions'))).toBe(true);
    } finally {
      await runtime.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'startup keeps the state chain it verified for the scripts it picks, and nothing else',
  async () => {
    // `AGENT_DEVICE_STATE_DIR=<root>/alias/../state`, with `alias` a link into `actual/x`. The kernel resolves
    // that base to `<root>/actual/state`, and creates under there; `path.join` folds the step away and answers
    // `<root>/state`, a DIFFERENT directory that happens to exist here. Two things follow, and they are not the
    // same demand:
    //
    // - The runtime, its store, the lock, the registration and the tombstones keep the name the setting spells,
    //   as they have always done. A client reads those entries by the same setting and the same rule, and the
    //   kernel resolves the step for it, so one spelling is one entry. Answering them with the verified name
    //   would move them out of what every client can name.
    // - The two destinations the DAEMON picks for itself — a default recording, and a remote version — are
    //   CREATED below that base, so they go where the walk arrived and only if that chain is private ground.
    const root = mkdtempForTestSync('agent-device-startup-state-alias-');
    // `actual/x` exists, and `actual` (one step above where the link lands) is where the kernel's `..`
    // arrives — so the state base has to be there before the walk can stand on it.
    fs.mkdirSync(path.join(root, 'actual', 'x'), { recursive: true });
    fs.symlinkSync(path.join(root, 'actual', 'x'), path.join(root, 'alias'));
    // Spelled by hand: `path.join` would fold the step here, and the setting has to carry it to the daemon.
    const configuredBase = `${root}/alias/../state`;
    const verifiedBase = path.join(root, 'actual', 'state');
    const foldedBase = path.join(root, 'state');
    // The folded name already stands, the way a previous run that folded left it: owned by this user, and open.
    fs.mkdirSync(path.join(foldedBase, 'sessions'), { recursive: true });
    fs.chmodSync(foldedBase, 0o755);

    // The composition input is the real construction: it is what the server passes to the root's factory.
    let composed: DaemonRuntimeDepsInput | undefined;
    const { runtime, skipped } = await withDiagnosticsScope({ session: 'daemon' }, async () => ({
      runtime: await startDaemonRuntime({
        host: hostFor(configuredBase),
        ...silent,
        composeDeps: daemonRuntimeDepsFixture((input) => {
          composed = input;
          return {};
        }),
      }),
      skipped: countDiagnosticEventsByPhase(['daemon_state_mode_repair_skipped']),
    }));
    try {
      // Everything a CLIENT names too — the base, the sessions dir, and behind them the lock, the registration
      // and the tombstones — keeps the spelling the setting gave, exactly as on main. A client reads those
      // entries by the same setting with the same rule, and the kernel resolves the step for it, so one
      // spelling is one entry. Rebinding them to the verified chain would move them out of what a client can
      // name. `baseDir` is the spelled text; `sessionsDir` is what `path.join` has always made of it.
      const input = composed!;
      expect(input.baseDir).toBe(`${root}/alias/../state`);
      expect(input.sessionsDir).toBe(path.join(foldedBase, 'sessions'));
      // Startup repaired the base it verified: the chain the kernel arrives at stands private.
      expect(modeOf(verifiedBase)).toBe(0o700);
      // Exactly one level is skipped, and it is the honest one: startup also ensures `sessions/` under the name
      // the setting spells, and that name is the FOLDED text, so the repair of the verified chain stops at a
      // level that spelled name never creates. Narrowing to the two script destinations leaves that as it is;
      // the writer asks for the same chain again, for the directories it creates itself.
      expect(skipped).toBe(1);

      const store = new SessionStore(input.sessionsDir, createTestHostEnvironment(), input.baseDir);
      const record = (name: string, extra: Parameters<typeof authoringPublication>[1]) =>
        store.writeSessionLog(
          store.publish(
            name,
            makeAuthoringSession(name, {
              scriptPublication: authoringPublication('armed', extra),
              actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
            }),
          ),
        );

      // The default recording: a directory this daemon creates for itself, so it stands on the chain judged
      // from the base, and not on the folded text `path.join` made of the same setting.
      const written = record('journey', {});
      if (!written.written) throw new Error(`recording refused: ${JSON.stringify(written)}`);
      expect(path.dirname(written.path)).toBe(path.join(verifiedBase, 'sessions'));
      // The remote version, in the directory the same answer names for it.
      const version = record('download', { remote: true });
      if (!version.written) throw new Error(`remote version refused: ${JSON.stringify(version)}`);
      expect(path.dirname(version.path)).toBe(
        path.join(verifiedBase, 'sessions', 'remote-scripts'),
      );
      expect(modeOf(path.join(verifiedBase, 'sessions'))).toBe(0o700);

      // The folded directory is the proof: nobody judged it, so nobody wrote in it or changed its mode.
      expect(modeOf(foldedBase)).toBe(0o755);
      expect(fs.readdirSync(path.join(foldedBase, 'sessions'))).toEqual([]);
    } finally {
      await runtime.close();
    }
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

/** Why a recording was not saved, from the typed reason the writer returned it in. */
function refusalOf(result: ReturnType<SessionStore['writeSessionLog']>): Record<string, unknown> {
  expect(result.written).toBe(false);
  if (result.written || !result.error) throw new Error('expected a refused recording');
  return result.error.details as Record<string, unknown>;
}
