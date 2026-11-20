import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runCliCapture } from './cli-capture.ts';

/**
 * The admission `src/cli.ts` asks for once, where the invocation resolves its `DaemonPaths`, is what every
 * state-directory read of that invocation hangs off. Two reads happen before a command reaches the daemon
 * client: the active connection defaults can supply the daemon URL and config from that directory, and the
 * upgrade notifier writes into it. `daemon status` reads the root and starts nothing, so these runs decide the
 * admission alone.
 */
test('a CLI run refuses a planted link at its state root before reading anything there', async () => {
  const under = mkdtempForTestSync('agent-device-cli-state-root-link-');
  const outside = path.join(under, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(
    path.join(outside, 'connection.json'),
    '{"session":"chosen-by-another-account"}\n',
  );
  const stateDir = path.join(under, 'state');
  fs.symlinkSync(outside, stateDir);

  const run = await runCliCapture(['daemon', 'status', '--json', '--state-dir', stateDir]);

  assert.equal(run.code, 1);
  assert.match(run.stdout, /Refusing to use the daemon state directory/);
  assert.match(run.stdout, /daemon_state_root_unsafe|is a symbolic link/);
  // The connection state the link points at was never read, and nothing was written through it.
  assert.deepEqual(fs.readdirSync(outside), ['connection.json']);
});

// The shape #4649 reports: a root a plain `mkdir` left at the host's umask default. The run repairs it and
// proceeds, because a mode the owner can change never decides whether a command runs.
test('a CLI run repairs a state root the umask left open, and proceeds', async () => {
  const under = mkdtempForTestSync('agent-device-cli-state-root-repair-');
  const stateDir = path.join(under, 'state');
  const previous = process.umask(0o022);
  try {
    fs.mkdirSync(stateDir);
  } finally {
    process.umask(previous);
  }
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o755);

  const run = await runCliCapture(['daemon', 'status', '--json', '--state-dir', stateDir]);

  assert.equal(run.code, null);
  assert.match(run.stdout, /"state": "stopped"/);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
});
