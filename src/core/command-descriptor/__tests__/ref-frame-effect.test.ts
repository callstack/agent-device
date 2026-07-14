import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import {
  DAEMON_COMMAND_DESCRIPTORS,
  resolveRefFrameEffect,
  type RefFrameEffect,
} from '../../../daemon/daemon-command-registry.ts';
import type { DaemonRequest } from '../../../daemon/types.ts';

// ADR 0014 migration step 2: the ref-frame-effect classification is an
// honesty/completeness guard. Every command that reaches a session-owning daemon
// leaf must classify how it relates to the authorized ref frame, so a device
// mutation cannot be added on a path that silently leaves stale refs admissible.

function makeRequest(command: string, positionals: string[] = []): DaemonRequest {
  return { command, token: 'gate-token', session: 'gate-session', positionals, flags: {} };
}

/**
 * Public commands that never reach a session-owning daemon leaf by their own
 * name, so they carry no ref-frame classification. `install-from-source`'s
 * daemon writer sends the `install_source` internal command (which IS
 * classified), so the daemon never receives `install-from-source` itself. This
 * is the ONLY unclassified public command: if it grows, a new daemon-projected
 * mutation may be slipping past the gate — add its facet, do not extend this
 * list without proving the command cannot mutate through the daemon.
 */
const NON_DAEMON_PUBLIC_COMMANDS = new Set<string>([PUBLIC_COMMANDS.installFromSource]);

test('every daemon-projected command classifies a ref-frame effect', () => {
  for (const descriptor of DAEMON_COMMAND_DESCRIPTORS) {
    assert.ok(
      descriptor.refFrameEffect !== undefined,
      `daemon command ${descriptor.command} declares no refFrameEffect (ADR 0014)`,
    );
  }
});

test('every public command is classified or explicitly non-daemon', () => {
  const daemonCommands = new Set(
    DAEMON_COMMAND_DESCRIPTORS.filter((d) => d.refFrameEffect !== undefined).map((d) => d.command),
  );
  for (const command of Object.values(PUBLIC_COMMANDS)) {
    if (NON_DAEMON_PUBLIC_COMMANDS.has(command)) continue;
    assert.ok(
      daemonCommands.has(command),
      `public command ${command} has no ref-frame classification and is not in the ` +
        `explicit non-daemon allowlist — a daemon-projected mutation may be unclassified`,
    );
  }
});

test('app-switcher no longer bypasses classification (ADR 0014 escape hatch)', () => {
  // app-switcher reaches the generic daemon leaf and mutates the device. Before
  // ADR 0014 it had no daemon facet and relied on the registry's generic
  // fallback, so it could not be classified. It must now resolve to a concrete
  // mutating effect.
  assert.equal(resolveRefFrameEffect(makeRequest('app-switcher')), 'may-invalidate');
});

test('resolver commands classify per selected subaction', () => {
  // keyboard: status/get probes preserve; dismiss/enter/return mutate. enter and
  // return dispatch a real return key, so they must NOT be preserve.
  assert.equal(resolveRefFrameEffect(makeRequest('keyboard')), 'preserve');
  assert.equal(resolveRefFrameEffect(makeRequest('keyboard', ['status'])), 'preserve');
  assert.equal(resolveRefFrameEffect(makeRequest('keyboard', ['get'])), 'preserve');
  assert.equal(resolveRefFrameEffect(makeRequest('keyboard', ['dismiss'])), 'may-invalidate');
  assert.equal(resolveRefFrameEffect(makeRequest('keyboard', ['enter'])), 'may-invalidate');
  assert.equal(resolveRefFrameEffect(makeRequest('keyboard', ['return'])), 'may-invalidate');
  // alert: get/wait read, accept/dismiss mutate.
  assert.equal(resolveRefFrameEffect(makeRequest('alert')), 'preserve');
  assert.equal(resolveRefFrameEffect(makeRequest('alert', ['get'])), 'preserve');
  assert.equal(resolveRefFrameEffect(makeRequest('alert', ['wait'])), 'preserve');
  assert.equal(resolveRefFrameEffect(makeRequest('alert', ['accept'])), 'may-invalidate');
  assert.equal(resolveRefFrameEffect(makeRequest('alert', ['dismiss'])), 'may-invalidate');
});

test('representative literal classifications resolve as declared', () => {
  const cases: Array<[string, RefFrameEffect]> = [
    ['snapshot', 'preserve'],
    ['diff', 'preserve'],
    ['get', 'preserve'],
    ['is', 'preserve'],
    ['screenshot', 'preserve'],
    ['clipboard', 'preserve'],
    ['press', 'may-invalidate'],
    ['click', 'may-invalidate'],
    ['fill', 'may-invalidate'],
    ['type', 'may-invalidate'],
    ['scroll', 'may-invalidate'],
    ['back', 'may-invalidate'],
    ['open', 'may-invalidate'],
    ['viewport', 'may-invalidate'],
    ['batch', 'delegated'],
    ['replay', 'delegated'],
    ['test', 'delegated'],
  ];
  for (const [command, expected] of cases) {
    assert.equal(resolveRefFrameEffect(makeRequest(command)), expected, `${command} effect`);
  }
});

test('non-daemon commands resolve to no effect', () => {
  // A command the daemon never receives by name has no classification.
  assert.equal(resolveRefFrameEffect(makeRequest('install-from-source')), undefined);
});
