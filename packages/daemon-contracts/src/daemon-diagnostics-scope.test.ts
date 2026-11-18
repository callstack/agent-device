import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { withDaemonDiagnosticsScope } from './daemon-diagnostics-scope.ts';
import { mkdtempForTestSync, withCapturedStderrAsync } from '@agent-device/test-kit';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempForTestSync('agent-device-daemon-diagnostics-scope-');
  logPath = path.join(dir, 'daemon.log');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLoggedEvents(): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('defaults to a debug daemon scope on the daemon session and returns the body result', async () => {
  const result = await withDaemonDiagnosticsScope({ logPath }, () => {
    emitDiagnostic({ level: 'warn', phase: 'probe', data: { n: 1 } });
    return 'done';
  });

  assert.equal(result, 'done');
  const events = readLoggedEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.command, 'daemon');
  assert.equal(events[0]?.session, 'daemon');
  assert.equal(events[0]?.phase, 'probe');
});

test('forces the buffered events of a non-debug scope out once the body returns', async () => {
  await withDaemonDiagnosticsScope({ logPath, command: 'daemon-startup', debug: false }, () => {
    emitDiagnostic({ level: 'warn', phase: 'first' });
    emitDiagnostic({ level: 'warn', phase: 'second' });
    assert.deepEqual(readLoggedEvents(), []);
  });

  const events = readLoggedEvents();
  assert.deepEqual(
    events.map((event) => event.phase),
    ['first', 'second'],
  );
  assert.ok(events.every((event) => event.command === 'daemon-startup'));
});

test('keeps the record of a failed body and still rethrows', async () => {
  await assert.rejects(
    withDaemonDiagnosticsScope({ logPath, debug: false }, async () => {
      emitDiagnostic({ level: 'warn', phase: 'kept' });
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.deepEqual(
    readLoggedEvents().map((event) => event.phase),
    ['kept'],
  );
});

test.skipIf(process.platform === 'win32')(
  'runs the body with no log sink when the state rule refuses that log',
  async () => {
    // The log is a state record, so it is a sink only while the state rule accepts it. Writing diagnostics at a
    // refused name would put them through the link (or block on the FIFO) that made the refusal, which is the
    // very thing being reported. So the scope runs, and the events leave by stderr.
    const victim = path.join(dir, 'theirs.log');
    fs.writeFileSync(victim, 'not yours\n', { mode: 0o600 });
    fs.symlinkSync(victim, logPath, 'file');

    const said = await withCapturedStderrAsync(async () => {
      await withDaemonDiagnosticsScope({ logPath }, () => {
        emitDiagnostic({ level: 'warn', phase: 'unlogged' });
      });
    });

    // The link's target keeps its bytes, the refusal is said, and the event itself leaves by stderr — the one
    // route no entry in the refused directory can steer.
    assert.equal(fs.readFileSync(victim, 'utf8'), 'not yours\n');
    assert.match(said, /daemon_log_sink_refused/);
    assert.match(said, /unlogged/);
  },
);
