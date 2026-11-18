// Who establishes the daemon's state chain, and what that costs: one walk of the route the operator NAMED,
// said out loud once, and never a text substitution that changes which directory the rule judges (#4649).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { establishPrivateDaemonStateDir } from './daemon-registration-owner.ts';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A scratch root spelled the way the kernel spells it, so the walk's answer and this file's agree. */
function scratch(): string {
  return fs.realpathSync(mkdtempForTestSync('agent-device-establish-'));
}

skipOnWindows('the route the operator named is the route that gets judged', () => {
  // A `..` is folded away by every path helper, so an establishment step that normalized first would judge,
  // create, and re-mode a directory other than the one the operator pointed the daemon at — and would tell
  // them about that other directory. Establishment therefore passes the configured spelling on untouched, and
  // the refusal is about the route as spelled.
  const root = scratch();
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.chmodSync(real, 0o700);
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, 'mine\n');
  fs.chmodSync(outside, 0o644);
  // Spelled by hand: `path.join` would fold the step back out before anything could see it.
  const named = `${root}/state/../outside.json`;

  const said = captureStderr(() => establishPrivateDaemonStateDir(named));

  assert.match(said, /is not private/);
  assert.ok(said.includes(named), `the line must name the route as spelled: ${said}`);
  assert.equal(
    fs.existsSync(path.join(root, 'state')),
    false,
    'nothing is created for a refused route',
  );
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644, 'the named entry keeps its own mode');
});

skipOnWindows('one route is walked once, and its verdict is said once', () => {
  // Repeating the walk once per phase marker buys nothing: every marker write judges the chain again on its
  // own and proves its own descriptor. What the process owes the operator is ONE line about the exposure.
  const state = path.join(scratch(), 'state');
  fs.mkdirSync(state);
  fs.chmodSync(state, 0o1777);
  serveHostOwnership({ [state]: FOREIGN_UID });

  const said = captureStderr(() => {
    establishPrivateDaemonStateDir(state);
    establishPrivateDaemonStateDir(state);
  });

  assert.equal(said.match(/is not private/g)?.length, 1);
  assert.equal(
    fs.statSync(state).mode & 0o777,
    0o777,
    'ground this user does not own is left as it stands',
  );
});

skipOnWindows('a state verdict survives a stderr that cannot take it', () => {
  // The line is a REPORT about the state directory, and stderr is the launcher's own log handle — which can
  // still be a pipe nobody reads. Losing the write must neither throw into a daemon's startup nor make the
  // process forget what it found, so the write is contained and the ask stays answered.
  const state = path.join(scratch(), 'loose');
  fs.mkdirSync(state);
  fs.chmodSync(state, 0o1777);
  serveHostOwnership({ [state]: FOREIGN_UID });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
  });

  assert.doesNotThrow(() => establishPrivateDaemonStateDir(state));
  assert.doesNotThrow(() => establishPrivateDaemonStateDir(state));
});

/** Runs `run` with every write to this process's stderr collected, and returns what was said. */
function captureStderr(run: () => void): string {
  let said = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    said += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return said;
}
