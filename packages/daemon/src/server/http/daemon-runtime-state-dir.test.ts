// Startup, not the first `open`, is what makes the daemon's own state chain private. Both are on the chain
// of every recording the daemon picks a path for, and the destination-ancestry rule refuses a group-writable
// directory on it (ADR 0016), so a state directory an older release left at 0775 has to be forced before a
// session is ever created. What startup may NOT do is refuse a level whose mode it may not force: that
// decision belongs to the walk, per recording, and a host whose state it does not own still gets a daemon.
// (https://github.com/callstack/agent-device/pull/4584)

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
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
import {
  configuredStateBaseDisagrees,
  resolveDaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
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
  'startup refuses the recordings it picks for a state dir spelled `..` behind a link, and creates nothing',
  async () => {
    // `AGENT_DEVICE_STATE_DIR=<root>/alias/../state`, with `alias` a link into `actual/x`. The kernel resolves
    // that base to `<root>/actual/state`; `path.join` folds the step away and answers `<root>/state`. One
    // setting, two directories, and every path this daemon BUILDS — `sessions/`, the lock, the registration —
    // is a folded one, because `resolveDaemonPaths` hands out `path.join`'s answers. A state path has ONE
    // spelling, so the daemon keeps the configured text and refuses the two destinations it picks a path for,
    // rather than force a mode in, or write a recording under, a directory no client can name (ADR 0016).
    const root = mkdtempForTestSync('agent-device-startup-state-alias-');
    fs.mkdirSync(path.join(root, 'actual', 'x'), { recursive: true });
    fs.symlinkSync(path.join(root, 'actual', 'x'), path.join(root, 'alias'));
    // Spelled by hand: `path.join` would fold the step here, and the setting has to carry it to the daemon.
    const configuredBase = `${root}/alias/../state`;
    const walkedBase = path.join(root, 'actual', 'state');
    const foldedBase = path.join(root, 'state');
    // Both trees stand loose, the way a release that folded left one of them.
    fs.mkdirSync(path.join(walkedBase, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(foldedBase, 'sessions'), { recursive: true });
    for (const directory of [walkedBase, foldedBase]) fs.chmodSync(directory, 0o755);

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
      // Startup carries on: the daemon runs, on the text the operator spelled. Two skips, one per level it
      // asked for, each saying the setting names two directories.
      const input = composed!;
      expect(input.baseDir).toBe(`${root}/alias/../state`);
      expect(input.sessionsDir).toBe(path.join(foldedBase, 'sessions'));
      expect(skipped).toBe(2);
      // And startup created NOTHING in either tree — no forced mode, no `sessions` entry — because repairing
      // one of them would judge a chain the caller of the other one reads.
      for (const state of [walkedBase, foldedBase]) {
        expect(modeOf(state)).toBe(0o755);
        expect(fs.readdirSync(path.join(state, 'sessions'))).toEqual([]);
      }

      // The same answer the runtime hands ITS store: this setting names two directories, so the store
      // refuses the destinations it picks for itself before creating either of them.
      const store = new SessionStore(input.sessionsDir, createTestHostEnvironment(), false);
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

      // Both destinations the DAEMON picks for itself are refused, and the hint names the setting as the thing
      // to fix: an explicit `--save-script` path is a caller's own path and is unaffected.
      for (const name of ['journey', 'download']) {
        const refused = refusalOf(record(name, name === 'download' ? { remote: true } : {}));
        expect(refused).toMatchObject({ reason: 'state_chain_untrusted' });
        expect(String(refused.hint)).toContain('..');
      }
      // The proof: neither tree gained a `remote-scripts`, and neither gained a recording.
      for (const state of [walkedBase, foldedBase]) {
        expect(fs.readdirSync(path.join(state, 'sessions'))).toEqual([]);
      }

      // What the refused chain still does is run: the store's own state is created on the configured text, by
      // `main`'s recursive `mkdir`, and both markers round-trip through it (#4584).
      expect(store.resolveDaemonStateDir()).toBe(path.join(foldedBase));
      expect(store.ensureSessionDir('journey')).toBe(path.join(foldedBase, 'sessions', 'journey'));
      const marker = {
        owner: 'marker',
        expiredAtMs: Date.now(),
        expiresAt: Date.now() + 60_000,
        idleExpiryMs: 1_500,
        deviceKey: 'ios:sim-1',
      };
      store.writeIdleExpiryTombstone('marker', marker);
      expect(store.readIdleExpiryTombstone('marker')).toEqual(marker);
      store.clearIdleExpiryTombstone('marker');
      expect(store.readIdleExpiryTombstone('marker')).toBeUndefined();

      const reaped = store.publish('marker', makeAuthoringSession('marker', {}));
      store.writeRepairTombstone(reaped, 60_000, {
        code: 'COMMAND_FAILED',
        message: 'commit refused',
      });
      expect(store.readRepairTombstone('marker')?.commitFailure).toEqual({
        code: 'COMMAND_FAILED',
        message: 'commit refused',
      });
      store.clearRepairTombstone('marker');
      expect(store.readRepairTombstone('marker')).toBeUndefined();
    } finally {
      await runtime.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'startup delivers the recordings it picks to a state dir under a linked home',
  async () => {
    // The layout that MUST keep working: the home directory itself is the link (an encrypted volume, a data
    // disk), and the state dir is an ordinary directory below it. The setting spells itself, so there is one
    // directory to stand on and one tree for a client to read, every level is this uid's at 0700, and the
    // chain is private ground. A link AT the base is the case the walk refuses, and startup keeps that host
    // running with its own `mkdir` (the suite above pins both halves).
    const realHome = fs.realpathSync(mkdtempForTestSync('agent-device-startup-home-'));
    fs.chmodSync(realHome, 0o700);
    const parent = mkdtempForTestSync('agent-device-startup-link-');
    const linkedHome = path.join(parent, 'home');
    fs.symlinkSync(realHome, linkedHome);
    const stateDir = path.join(linkedHome, '.agent-device');

    const runtime = await startDaemonRuntime({
      host: hostFor(stateDir),
      ...silent,
      composeDeps: daemonRuntimeDepsFixture({}),
    });
    try {
      const { sessionsDir } = resolveDaemonPaths(stateDir);
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
        throw new Error(`a linked home refused its own recording: ${JSON.stringify(written)}`);
      // Recorded, and named by the spelling the operator gave: a client reads it back by the same text.
      expect(path.dirname(written.path)).toBe(sessionsDir);
      expect(fs.existsSync(written.path)).toBe(true);
      // The bytes are under the directory the link leads to, forced private from the base down.
      expect(fs.existsSync(path.join(realHome, '.agent-device', 'sessions'))).toBe(true);
      expect(modeOf(path.join(realHome, '.agent-device', 'sessions'))).toBe(0o700);
    } finally {
      await runtime.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'startup delivers the recordings it picks for a state dir spelled with a trailing or doubled separator',
  async () => {
    // `AGENT_DEVICE_STATE_DIR=~/.agent-device/` — the shape a shell variable, a Dockerfile `ENV` or a mounted
    // volume usually carries, and the one a first run cannot recover from if the two-spelling check mistakes a
    // SEPARATOR for a step. A trailing separator names the same directory, so it is not a disagreement: the
    // repair runs, the chain answers private, and both destinations the daemon picks for itself are delivered.
    // A doubled separator is the same question from the other side (`state//sessions`), and is answered the
    // same way. (https://github.com/callstack/agent-device/pull/4584 review)
    const root = mkdtempForTestSync('agent-device-startup-separators-');
    fs.chmodSync(root, 0o700);
    // Fresh: nothing below the setting exists, which is exactly when the old check latched the refusal.
    for (const [label, spelled] of [
      ['trailing', `${root}/agent-device/`],
      ['doubled', `${root}/agent-device/versions//live`],
    ] as const) {
      // Asked BEFORE anything exists, as startup asks it: the state directory is spelled long before it is
      // created, and a setting that is refused here stays refused for that daemon's whole life.
      const { baseDir, sessionsDir } = resolveDaemonPaths(spelled);
      const stateSpellingAgrees = !configuredStateBaseDisagrees(baseDir);
      expect({ label, stateSpellingAgrees }).toEqual({ label, stateSpellingAgrees: true });

      let composed: DaemonRuntimeDepsInput | undefined;
      const runtime = await startDaemonRuntime({
        host: hostFor(spelled),
        ...silent,
        composeDeps: daemonRuntimeDepsFixture((input) => {
          composed = input;
          return {};
        }),
      });
      try {
        const input = composed!;
        expect(input.baseDir).toBe(baseDir);
        expect(input.sessionsDir).toBe(sessionsDir);
        // Startup repaired the chain it was given.
        expect(modeOf(baseDir)).toBe(0o700);
        expect(modeOf(sessionsDir)).toBe(0o700);
        // The store is built as the runtime builds its own: same paths, same one startup answer.
        const store = new SessionStore(
          input.sessionsDir,
          createTestHostEnvironment(),
          stateSpellingAgrees,
        );
        for (const name of ['journey', 'download']) {
          const written = store.writeSessionLog(
            store.publish(
              name,
              makeAuthoringSession(name, {
                scriptPublication: authoringPublication(
                  'armed',
                  name === 'download' ? { remote: true } : {},
                ),
                actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
              }),
            ),
          );
          if (!written.written)
            throw new Error(
              `a ${label} separator refused its own recording: ${JSON.stringify(written)}`,
            );
          expect(fs.existsSync(written.path)).toBe(true);
        }
      } finally {
        await runtime.close();
      }
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'startup creates its own state over an ancestor it will not call private, and refuses only recordings',
  async () => {
    // A fresh state directory inside an ancestor another local user could write — the bind-mounted CI volume
    // and shared-scratch shape: world-writable and not sticky, so the walk will not stand on it. Startup may
    // not read that as a reason to stop: `mkdir -p` made these levels before this rule existed, and the
    // daemon's log, lock, registration and every artifact path sit below them. The chain is what refuses, and
    // only a recording the daemon picks a path for (#4584 review).
    const shared = mkdtempForTestSync('agent-device-startup-state-untrusted-');
    fs.chmodSync(shared, 0o777);
    const { baseDir, logPath, sessionsDir } = resolveDaemonPaths(path.join(shared, 'agent-device'));

    const { runtime, skipped } = await withDiagnosticsScope({ session: 'daemon' }, async () => ({
      runtime: await startDaemonRuntime({
        host: hostFor(baseDir),
        ...silent,
        composeDeps: daemonRuntimeDepsFixture({}),
      }),
      skipped: countDiagnosticEventsByPhase(['daemon_state_mode_repair_skipped']),
    }));
    try {
      // Startup got as far as the log it writes to: the base and its own levels were made, on ground the
      // repair will not vouch for. The mode is what this process's own recursive `mkdir` gave it — no group or
      // other access, and this uid's — because a state repair forces nothing on ground it refused to judge.
      expect(fs.existsSync(baseDir)).toBe(true);
      expect(modeOf(baseDir) & 0o077).toBe(0);
      expect(Number(fs.lstatSync(baseDir).uid)).toBe(process.getuid?.() ?? -1);
      expect(fs.existsSync(logPath)).toBe(true);
      // The skips are the chain saying where it stopped: once for the base and once for `sessions/`, the two
      // levels startup asks for, and it carried on past both.
      expect(skipped).toBe(2);

      // What the shared ground DOES refuse: the daemon's own recording destinations. Both go through the
      // chain, which never reached the destination walk, so neither is published.
      const store = new SessionStore(sessionsDir, createTestHostEnvironment());
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
      expect(refusalOf(record('journey', {}))).toMatchObject({ reason: 'state_chain_untrusted' });
      expect(refusalOf(record('download', { remote: true }))).toMatchObject({
        reason: 'state_chain_untrusted',
      });
      // And the refused remote version created nothing of its own: no `remote-scripts` appeared on a chain the
      // repair stopped above, which is the rule the blocker asked for.
      expect(fs.readdirSync(path.join(baseDir, 'sessions'))).not.toContain('remote-scripts');
    } finally {
      await runtime.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'creates a session directory THROUGH a refused `sessions` level, and saves no recording on it',
  async () => {
    // The refused level is `sessions/` itself — a link out of the state tree — and the session directory the
    // caller asks for does not exist on the far side yet. `main` made that work: the tombstone path ran one
    // recursive `mkdir` over the spelled session directory, which resolves the tail as TEXT and created it
    // wherever `sessions` points. When this PR moved creation behind the per-level walk, the walk stopped AT the
    // link and the own-state caller was handed a path to a directory nobody had made, so an idle-expiry
    // tombstone failed with `ENOENT` inside its own best-effort catch and the marker was simply lost (#4584
    // review). Main's `mkdir` is given back to that caller; what stays refused is the destination type.
    const stateDir = mkdtempForTestSync('agent-device-state-refused-level-');
    const { baseDir, sessionsDir } = resolveDaemonPaths(stateDir);
    fs.mkdirSync(baseDir, { recursive: true });
    const outside = path.join(stateDir, 'outside');
    fs.mkdirSync(outside);
    fs.chmodSync(outside, 0o755);
    fs.symlinkSync(outside, sessionsDir);
    const store = new SessionStore(sessionsDir, createTestHostEnvironment());
    const marker = {
      owner: 'journey',
      expiredAtMs: Date.now(),
      expiresAt: Date.now() + 60_000,
      idleExpiryMs: 1_000,
    };

    // The child is created, on the far side of the refused level, by `mkdir` alone — no `chmod`, no `fchmod`.
    const chmod = vi.spyOn(fs, 'chmodSync');
    const fchmod = vi.spyOn(fs, 'fchmodSync');
    expect(store.ensureSessionDir('journey')).toBe(path.join(sessionsDir, 'journey'));
    expect(chmod.mock.calls.map(([, mode]) => mode)).toEqual([]);
    expect(fchmod.mock.calls.map(([, mode]) => mode)).toEqual([]);
    expect(fs.lstatSync(path.join(outside, 'journey')).isDirectory()).toBe(true);

    // The write the lost marker was, now standing where main put it.
    store.writeIdleExpiryTombstone('journey', marker);
    expect(store.readIdleExpiryTombstone('journey')).toEqual(marker);

    // And what that chain still refuses: a recording destination of the daemon's own choosing, made nowhere.
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
    expect(fs.readdirSync(outside)).toEqual(['journey']);
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
