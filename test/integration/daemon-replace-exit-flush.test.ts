import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skipWhenLoopbackUnavailable } from '../../src/__tests__/test-utils/loopback.ts';
import { runCmdSync } from '../../src/utils/exec.ts';
import { stopProcessForTakeover } from '../../src/daemon/daemon-process.ts';
import { isProcessAlive } from '../../src/utils/host-process.ts';
import { runCliJson } from './test-helpers.ts';
import { PAYLOAD_MARKER } from './support/exit-payload.ts';

// #1596: a CLI command that finds its recorded daemon unreachable replaces it
// (`Replacing daemon (pid N, vX) in <state-dir>: unreachable`) and retries
// against a fresh one. Three field runs died with zero further agent actions
// immediately after that replace plus a SESSION_NOT_FOUND (the fresh daemon
// has no sessions yet, which is expected). This file locks down that a
// replace-mid-command always ends in a normal, fully-delivered structured
// error rather than a truncated or hung process.

const SUPPORT_DIR = path.join(import.meta.dirname, 'support');
const FIXTURE_TIMEOUT_MS = 10_000;

type DaemonInfo = {
  pid: number;
  processStartTime?: string;
};

test('daemon replace mid-command returns a structured, parseable error and exits normally', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) {
    return;
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replace-exit-flush-'));
  let info: DaemonInfo | null = null;
  try {
    // A real daemon, started by this codebase, so its recorded version/code
    // signature legitimately match — the only way to reach the "unreachable"
    // takeover reason (as opposed to a version/signature mismatch takeover).
    const started = runCliJson(['session', 'list', '--json', '--state-dir', stateDir]);
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);

    info = readDaemonInfo(stateDir);
    assert.equal(isProcessAlive(info.pid), true, 'expected the started daemon to be alive');

    // Kill it out from under its own metadata: daemon.json stays put and
    // still points at a pid that is now unreachable, reproducing the crash
    // the field transcripts observed.
    process.kill(info.pid, 'SIGKILL');
    await waitForProcessDeath(info.pid);

    const result = runCliJson(['close', '--json', '--state-dir', stateDir]);

    assert.equal(result.status, 1, formatUnexpected('exit code', result));
    assert.ok(
      result.stderr.includes('Replacing daemon') && result.stderr.includes('unreachable'),
      formatUnexpected('takeover notice on stderr', result),
    );
    assert.ok(result.json, formatUnexpected('parseable JSON stdout', result));
    assert.equal(result.json.success, false, formatUnexpected('success:false', result));
    assert.equal(
      result.json.error?.code,
      'SESSION_NOT_FOUND',
      formatUnexpected('SESSION_NOT_FOUND', result),
    );
    // #1596 requirement: a hint pointing at `open` is always present, not
    // just "fresh daemon, good luck" — this is the daemon.json truthfully
    // having no sessions, which is expected; only the error's shape/delivery
    // was ever in question.
    assert.match(
      result.json.error?.hint ?? '',
      /open/i,
      formatUnexpected('an `open` hint', result),
    );

    info = readDaemonInfo(stateDir);
  } finally {
    if (info) {
      await stopProcessForTakeover(info.pid, {
        termTimeoutMs: 1_500,
        killTimeoutMs: 1_500,
        expectedStartTime: info.processStartTime,
      });
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// Isolates the delivery guarantee from the end-to-end test above. The fixture
// writes a large payload through a real piped subprocess without asserting
// that the unsafe alternative must truncate under a particular OS, Node
// version, pipe configuration, or scheduler interleaving.
test('exitAfterFlush (the #1596 fix) delivers the full write before the process exits', () => {
  const { exitCode, stderr } = runFixture('exit-after-flush.ts');
  assert.equal(exitCode, 1);
  assert.ok(
    stderr.includes(PAYLOAD_MARKER),
    'expected the full payload, including its trailing marker',
  );
});

function runFixture(name: string): { exitCode: number; stderr: string } {
  const result = runCmdSync(
    process.execPath,
    ['--experimental-strip-types', path.join(SUPPORT_DIR, name)],
    { allowFailure: true, timeoutMs: FIXTURE_TIMEOUT_MS },
  );
  return { exitCode: result.exitCode, stderr: result.stderr };
}

async function waitForProcessDeath(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`daemon pid ${pid} did not die after SIGKILL`);
}

function readDaemonInfo(stateDir: string): DaemonInfo {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')) as DaemonInfo;
}

function formatUnexpected(
  expected: string,
  result: { status: number; stdout: string; stderr: string },
): string {
  return [
    `expected ${expected}`,
    `status: ${result.status}`,
    `stdout: ${result.stdout || '(empty)'}`,
    `stderr: ${result.stderr || '(empty)'}`,
  ].join('\n');
}
