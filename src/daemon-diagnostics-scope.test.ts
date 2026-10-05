import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { withDaemonDiagnosticsScope } from './daemon-diagnostics-scope.ts';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';

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
