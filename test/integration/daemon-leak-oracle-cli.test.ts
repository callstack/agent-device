import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import { readProcessCommand, readProcessStartTime } from '@agent-device/host-kit/process';

// #1781 B1: the oracle's `after-close` checkpoint is only meaningful when it can
// name the sessions that closed — without them it would accept every unfinalized
// capture handle and report clean, which is the vacuous mode the type system now
// refuses in code. The standalone CLI is the one caller that builds options from
// strings rather than types, so it must refuse the same invocation at runtime
// instead of silently degrading to that mode.

const ORACLE_PATH = 'test/integration/support/daemon-leak-oracle.ts';

function runOracle(args: string[]) {
  return runCmdSync(process.execPath, ['--experimental-strip-types', ORACLE_PATH, ...args], {
    allowFailure: true,
    timeoutMs: 60_000,
  });
}

test('the leak oracle CLI refuses an after-close checkpoint that names no session', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-leak-oracle-cli-'));
  // A closed session that left an unfinalized capture handle: the exact residue
  // the refused invocation would have reported clean.
  const sessionDir = path.join(stateDir, 'sessions', 'closed-one');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'screen-recording.resource.json'),
    `${JSON.stringify({ lifecycle: 'open' })}\n`,
  );
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const refused = runOracle(['--state-dir', stateDir, '--phase', 'after-close']);
  assert.notEqual(refused.exitCode, 0, `expected a refusal, got:\n${refused.stdout}`);
  assert.match(refused.stderr, /--phase after-close requires at least one --closed-session/);
  // A refusal, not a leak report: the checkpoint never ran.
  assert.doesNotMatch(refused.stdout, /daemon leak oracle:/);

  // The same invocation, once it names the session, runs and finds the handle.
  const named = runOracle([
    '--state-dir',
    stateDir,
    '--phase',
    'after-close',
    '--closed-session',
    'closed-one',
    '--settle-ms',
    '0',
  ]);
  assert.equal(named.exitCode, 1, `expected a leak report, got:\n${named.stdout}${named.stderr}`);
  assert.match(named.stdout, /LEAK \(after-close\)/);
  assert.match(named.stdout, /sessions\/closed-one\/screen-recording\.resource\.json/);

  // `after-shutdown` needs no session identity and is unaffected by the guard.
  const shutdown = runOracle(['--state-dir', stateDir, '--settle-ms', '0']);
  assert.equal(shutdown.exitCode, 1, shutdown.stderr);
  assert.match(shutdown.stdout, /LEAK \(after-shutdown\)/);
});

test('the leak oracle CLI reads an exact daemon-owned process record', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-leak-record-cli-'));
  const startTime = readProcessStartTime(process.pid);
  const command = readProcessCommand(process.pid);
  if (!startTime || !command) {
    t.skip('host process identity is unavailable in this sandbox');
    fs.rmSync(stateDir, { recursive: true, force: true });
    return;
  }
  fs.writeFileSync(
    path.join(stateDir, 'owned-processes.json'),
    `${JSON.stringify({
      version: 1,
      processes: [{ pid: process.pid, startTime, command, purpose: 'managed-web-browser' }],
    })}\n`,
  );
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const result = runOracle(['--state-dir', stateDir, '--settle-ms', '0']);

  assert.equal(result.exitCode, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /managed-web-browser: pid/);
  assert.match(result.stdout, /owned processes still alive: 1/);
});
