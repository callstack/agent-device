import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import {
  appendSessionEvent,
  flushSessionEventLogWrites,
  readSessionEventLog,
  resolveSessionEventLogPath,
} from '../session-event-log.ts';
import { digestEventLogLine } from '../session-event-log-lines.ts';
import {
  EVENT_LOG_CURSOR_EXPIRED_REASON,
  EVENT_LOG_WINDOW_UNVERIFIED_REASON,
  resolveRotatedSessionEventLogPath,
  resolveSessionEventLogMaxBytes,
} from '../session-event-log-window.ts';

const originalMaxBytes = process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMaxBytes === undefined) delete process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES;
  else process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = originalMaxBytes;
});

test('a partial failed append refuses later appends and cursor reads without changing evidence', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-partial-'),
  );
  const append = fs.promises.appendFile.bind(fs.promises);
  const partial = '{"version":1,"summary":';
  const writes = vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async (file) => {
    await append(file, partial, 'utf8');
    throw Object.assign(new Error('partial write'), { code: 'ENOSPC' });
  });
  appendSessionEvent(eventLogPath, 'default', { kind: 'request.started' }, {});
  await flushSessionEventLogWrites(eventLogPath);
  appendSessionEvent(eventLogPath, 'default', { kind: 'request.finished' }, {});
  await flushSessionEventLogWrites(eventLogPath);

  assert.equal(writes.mock.calls.length, 1);
  assert.equal(fs.readFileSync(eventLogPath, 'utf8'), partial);
  assert.equal(readError(eventLogPath, '0').details?.reason, EVENT_LOG_WINDOW_UNVERIFIED_REASON);
});

test('a persisted incomplete rotated tail refuses placement even when its digest and line count match', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-partial-rotation-'),
  );
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '1024';
  await appendEvents(eventLogPath, 0, 12);
  const rotatedPath = resolveRotatedSessionEventLogPath(eventLogPath);
  const bytes = fs.readFileSync(rotatedPath);
  assert.equal(bytes.at(-1), 0x0a);
  fs.truncateSync(rotatedPath, bytes.length - 1);

  assert.equal(readError(eventLogPath, '0').details?.reason, EVENT_LOG_WINDOW_UNVERIFIED_REASON);
  assert.deepEqual(fs.readFileSync(rotatedPath), bytes.subarray(0, -1));
});

test('failed temporary-file cleanup cannot accumulate a new sidecar file on each maintenance attempt', async () => {
  const sessionDir = mkdtempForTestSync('agent-device-event-log-temp-bound-');
  const eventLogPath = resolveSessionEventLogPath(sessionDir);
  const existing = `${JSON.stringify({
    version: 1,
    kind: 'request.started',
    session: 'default',
    ts: '2026-11-12',
    summary: 'existing'.repeat(16),
  })}\n`;
  fs.writeFileSync(eventLogPath, existing);
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
    if (String(destination) === `${eventLogPath}.window.json`) {
      throw Object.assign(new Error('publication refused'), { code: 'EACCES' });
    }
    await rename(source, destination);
  });
  vi.spyOn(fs.promises, 'unlink').mockRejectedValue(
    Object.assign(new Error('cleanup refused'), { code: 'EACCES' }),
  );
  const env = { AGENT_DEVICE_EVENT_LOG_MAX_BYTES: String(Buffer.byteLength(existing) + 20) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    appendSessionEvent(eventLogPath, 'default', { kind: 'request.started' }, env);
    await flushSessionEventLogWrites(eventLogPath);
  }

  assert.equal(fs.readdirSync(sessionDir).filter((name) => name.endsWith('.tmp')).length, 1);
  assert.equal(fs.readFileSync(eventLogPath, 'utf8'), existing);
});

async function appendEvents(eventLogPath: string, from: number, to: number): Promise<void> {
  for (let index = from; index < to; index += 1) {
    appendSessionEvent(
      eventLogPath,
      'default',
      {
        kind: 'request.started',
        command: 'snapshot',
        summary: `event ${index}`,
      },
      process.env,
    );
  }
  await flushSessionEventLogWrites(eventLogPath);
}

function summaries(eventLogPath: string, cursor?: string, limit?: number): string[] {
  return readSessionEventLog(eventLogPath, { cursor, limit }).events.map(
    (event) => event.summary ?? '',
  );
}

function readError(eventLogPath: string, cursor: string): AppError {
  try {
    readSessionEventLog(eventLogPath, { cursor });
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected cursor ${cursor} to be refused` });
}

function retainedLineCount(eventLogPath: string): number {
  return [resolveRotatedSessionEventLogPath(eventLogPath), eventLogPath]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length)
    .reduce((sum, count) => sum + count, 0);
}

test('rotation caps events.ndjson while cursors stay absolute across the retained window', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-cap-'),
  );
  // One entry is ~110 bytes; a 1 KB cap rotates every 9-10 entries, so 40
  // entries force several rotations and at least one dropped generation.
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '1024';
  assert.equal(resolveSessionEventLogMaxBytes(process.env), 1024);

  await appendEvents(eventLogPath, 0, 40);

  assert.equal(fs.existsSync(resolveRotatedSessionEventLogPath(eventLogPath)), true);
  assert.ok(
    fs.statSync(eventLogPath).size <= 1024 + 200,
    `active file must stay near the cap, got ${fs.statSync(eventLogPath).size} bytes`,
  );
  const retained = retainedLineCount(eventLogPath);
  assert.ok(retained < 40, `expected dropped events, retained ${retained}`);

  // A cursor inside the retained window names the same event it named before
  // rotation, spanning the rotated and active files.
  const earliest = 40 - retained;
  assert.deepEqual(
    summaries(eventLogPath, String(earliest), 500),
    Array.from({ length: retained }, (_, index) => `event ${earliest + index}`),
  );
  const tail = readSessionEventLog(eventLogPath, { cursor: '38', limit: 1 });
  assert.deepEqual(
    tail.events.map((event) => event.summary),
    ['event 38'],
  );
  assert.equal(tail.nextCursor, '39');
  // endCursor is absolute like nextCursor, whichever retained file the scan stopped in.
  assert.equal(tail.endCursor, '39');
  assert.equal(
    readSessionEventLog(eventLogPath, { cursor: String(earliest), limit: 2 }).endCursor,
    String(earliest + 2),
  );
  assert.equal(
    readSessionEventLog(eventLogPath, { cursor: String(earliest), limit: 500 }).endCursor,
    '40',
  );
  assert.deepEqual(summaries(eventLogPath, tail.nextCursor, 1), ['event 39']);

  const expired = readError(eventLogPath, '0');
  assert.equal(expired.code, 'COMMAND_FAILED');
  assert.equal(expired.details?.reason, EVENT_LOG_CURSOR_EXPIRED_REASON);
  assert.equal(expired.details?.earliestCursor, earliest);
  assert.equal(typeof expired.details?.hint, 'string');

  // The window survives further rotations.
  await appendEvents(eventLogPath, 40, 60);
  assert.deepEqual(summaries(eventLogPath, '58', 2), ['event 58', 'event 59']);
});

test('a hand-deleted rotated generation expires its cursors instead of shifting them', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-gap-'),
  );
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '1024';
  await appendEvents(eventLogPath, 0, 40);

  const retained = retainedLineCount(eventLogPath);
  const earliest = 40 - retained;
  const rotatedPath = resolveRotatedSessionEventLogPath(eventLogPath);
  const rotatedLines = fs.readFileSync(rotatedPath, 'utf8').split('\n').filter(Boolean).length;
  fs.rmSync(rotatedPath);

  // Cursors that lived in the deleted generation are refused, not answered
  // with the surviving file's events; the surviving file keeps its own indices.
  const expired = readError(eventLogPath, String(earliest));
  assert.equal(expired.details?.reason, EVENT_LOG_CURSOR_EXPIRED_REASON);
  assert.equal(expired.details?.earliestCursor, earliest + rotatedLines);
  assert.deepEqual(summaries(eventLogPath, String(earliest + rotatedLines), 1), [
    `event ${earliest + rotatedLines}`,
  ]);
});

test('a reader that lands between the window write and the rename still resolves cursors', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-race-'),
  );
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '1024';
  await appendEvents(eventLogPath, 0, 40);

  // Rotation writes the sidecar describing the post-rename world *before* the
  // rename, so this exact state is observable on the normal event loop. Build
  // it deterministically: record the live active file as the next generation
  // while it is still the active file.
  const windowPath = `${eventLogPath}.window.json`;
  const sidecar = JSON.parse(fs.readFileSync(windowPath, 'utf8')) as {
    version: number;
    generations: { firstLineIndex: number; lineCount: number; firstLineDigest: string }[];
  };
  const newest = sidecar.generations.at(-1)!;
  const activeLines = fs.readFileSync(eventLogPath, 'utf8').split('\n').filter(Boolean);
  const activeStart = newest.firstLineIndex + newest.lineCount;
  fs.writeFileSync(
    windowPath,
    JSON.stringify({
      version: sidecar.version,
      generations: [
        newest,
        {
          firstLineIndex: activeStart,
          lineCount: activeLines.length,
          firstLineDigest: digestEventLogLine(activeLines[0]!),
        },
      ],
    }),
    'utf8',
  );

  // Both retained files must still answer for the events they actually hold.
  assert.deepEqual(summaries(eventLogPath, String(activeStart), 1), [`event ${activeStart}`]);
  assert.deepEqual(summaries(eventLogPath, String(newest.firstLineIndex), 1), [
    `event ${newest.firstLineIndex}`,
  ]);
});

test('a retained generation whose length moved is refused rather than mapped', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-tamper-'),
  );
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '1024';
  await appendEvents(eventLogPath, 0, 40);

  const rotatedPath = resolveRotatedSessionEventLogPath(eventLogPath);
  fs.appendFileSync(
    rotatedPath,
    `${JSON.stringify({ version: 1, ts: 'x', session: 'd', kind: 'action.recorded' })}\n`,
  );

  const unverified = readError(eventLogPath, '0');
  assert.equal(unverified.details?.reason, EVENT_LOG_WINDOW_UNVERIFIED_REASON);
});

test('an unreadable window sidecar fails reads typed and never blocks appends', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-bad-'),
  );
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '1024';
  await appendEvents(eventLogPath, 0, 40);

  fs.writeFileSync(`${eventLogPath}.window.json`, '{ not json', 'utf8');

  const unverified = readError(eventLogPath, '0');
  assert.equal(unverified.code, 'COMMAND_FAILED');
  assert.equal(unverified.details?.reason, EVENT_LOG_WINDOW_UNVERIFIED_REASON);
  assert.equal(typeof unverified.details?.hint, 'string');

  // Writes keep flowing past the corrupt sidecar, including across the
  // rotations the following appends trigger.
  const sizeBefore = fs.statSync(eventLogPath).size;
  await appendEvents(eventLogPath, 40, 60);
  assert.ok(
    fs.statSync(eventLogPath).size > 0 && retainedLineCount(eventLogPath) >= 9,
    `appends must survive a corrupt sidecar (size before ${sizeBefore})`,
  );
  assert.equal(readError(eventLogPath, '0').details?.reason, EVENT_LOG_WINDOW_UNVERIFIED_REASON);
});

test('a rotated generation with no window record is refused rather than renumbered', async () => {
  const dir = mkdtempForTestSync('agent-device-event-log-orphan-');
  const eventLogPath = resolveSessionEventLogPath(dir);
  await appendEvents(eventLogPath, 0, 3);
  fs.copyFileSync(eventLogPath, resolveRotatedSessionEventLogPath(eventLogPath));

  assert.equal(readError(eventLogPath, '0').details?.reason, EVENT_LOG_WINDOW_UNVERIFIED_REASON);
});

test('the default cap leaves an ordinary session log unrotated, and a non-integer override is ignored', async () => {
  const dir = mkdtempForTestSync('agent-device-event-log-default-cap-');
  const eventLogPath = resolveSessionEventLogPath(dir);
  // "5MB" must not be read as 5 bytes, which would rotate on every entry.
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '5MB';
  assert.equal(resolveSessionEventLogMaxBytes(process.env), 5 * 1024 * 1024);

  await appendEvents(eventLogPath, 0, 3);

  assert.deepEqual(fs.readdirSync(dir), [path.basename(eventLogPath)]);
  assert.deepEqual(summaries(eventLogPath), ['event 0', 'event 1', 'event 2']);
});

test('a tailing reader resumes from endCursor past unparsable lines without replaying events', async () => {
  delete process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES;
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-tail-'),
  );
  await appendEvents(eventLogPath, 0, 2);
  fs.appendFileSync(eventLogPath, '{"version":999,"kind":"future"}\n');
  await appendEvents(eventLogPath, 2, 3);

  const caughtUp = readSessionEventLog(eventLogPath, { cursor: '0', limit: 4 });
  assert.deepEqual(
    caughtUp.events.map((event) => event.summary),
    ['event 0', 'event 1', 'event 2'],
  );
  assert.equal(caughtUp.nextCursor, undefined);
  assert.equal(caughtUp.endCursor, '4');

  await appendEvents(eventLogPath, 3, 4);
  const resumed = readSessionEventLog(eventLogPath, { cursor: caughtUp.endCursor, limit: 4 });
  assert.deepEqual(
    resumed.events.map((event) => event.summary),
    ['event 3'],
  );
  assert.equal(resumed.endCursor, '5');

  const pastEnd = readSessionEventLog(eventLogPath, { cursor: '9', limit: 4 });
  assert.deepEqual(pastEnd.events, []);
  assert.equal(pastEnd.endCursor, '9');

  const partial = readSessionEventLog(eventLogPath, { cursor: '1', limit: 2 });
  assert.equal(partial.nextCursor, '3');
  assert.equal(partial.endCursor, '3');
});

test('the 128-entry limit includes in-flight work and releases on completion', async () => {
  const eventLogPath = resolveSessionEventLogPath(mkdtempForTestSync('event-queue-count-'));
  const append = fs.promises.appendFile.bind(fs.promises);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async (...args) => {
    entered();
    await blocked;
    return append(...args);
  });
  const send = (index: number) =>
    appendSessionEvent(
      eventLogPath,
      'default',
      {
        kind: 'request.started',
        summary: `event ${index}`,
      },
      {},
    );
  send(0);
  await started;
  for (let i = 1; i <= 128; i += 1) send(i);
  release();
  await flushSessionEventLogWrites(eventLogPath);
  send(129);
  await flushSessionEventLogWrites(eventLogPath);
  assert.deepEqual(summaries(eventLogPath, '0', 500), [
    ...Array.from({ length: 128 }, (_, i) => `event ${i}`),
    'event 129',
  ]);
});

test('serialized byte admission includes in-flight payload and reports both limits', async () => {
  const dir = mkdtempForTestSync('event-queue-bytes-');
  const eventLogPath = resolveSessionEventLogPath(dir);
  const logPath = path.join(dir, 'diagnostics.ndjson');
  const max = 16 * 1024 * 1024;
  const env = { AGENT_DEVICE_EVENT_LOG_MAX_BYTES: String(max * 2) };
  const append = fs.promises.appendFile.bind(fs.promises);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async (...args) => {
    entered();
    await blocked;
    return append(...args);
  });
  const fixed = { kind: 'request.started' as const, ts: 'fixed' };
  const makeEvent = (keySize: number) => ({ ...fixed, details: { ['x'.repeat(keySize)]: 1 } });
  const lineSize = (event: ReturnType<typeof makeEvent>) =>
    Buffer.byteLength(
      `${JSON.stringify(Object.assign({ version: 1, ts: 'fixed', session: 'default' }, event))}\n`,
    );
  const baseline = lineSize(makeEvent(1)) - 1;
  const half = makeEvent(Math.floor(max / 2) - baseline);
  const tooLarge = makeEvent(max - baseline + 1);
  await withDiagnosticsScope({ debug: true, logPath }, async () => {
    appendSessionEvent(eventLogPath, 'default', half, env);
    await started;
    appendSessionEvent(eventLogPath, 'default', half, env);
    appendSessionEvent(eventLogPath, 'default', fixed, env);
    appendSessionEvent(eventLogPath, 'default', tooLarge, env);
    release();
    await flushSessionEventLogWrites(eventLogPath);
    appendSessionEvent(eventLogPath, 'default', fixed, env);
    await flushSessionEventLogWrites(eventLogPath);
  });
  assert.equal(
    fs.statSync(eventLogPath).size,
    max +
      Buffer.byteLength(
        `${JSON.stringify(Object.assign({ version: 1, ts: 'fixed', session: 'default' }, fixed))}\n`,
      ),
  );
  const diagnostics = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    diagnostics
      .filter((event) => event.phase === 'session_event_log_write_failed')
      .map((event) => [event.data.reason, event.data.operation]),
    [
      ['queue-full', 'admission'],
      ['entry-too-large', 'admission'],
    ],
  );
});

test('failed rotations preserve the cap and later new events recover in cursor order', async () => {
  const eventLogPath = resolveSessionEventLogPath(mkdtempForTestSync('event-rotation-failure-'));
  const env = { AGENT_DEVICE_EVENT_LOG_MAX_BYTES: '200' };
  const send = (summary: string) =>
    appendSessionEvent(
      eventLogPath,
      'default',
      {
        kind: 'request.started',
        ts: 'fixed',
        summary,
      },
      env,
    );
  send('first');
  send('second');
  await flushSessionEventLogWrites(eventLogPath);
  const before = fs.readFileSync(eventLogPath);
  const rename = fs.promises.rename.bind(fs.promises);
  const fault = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
    if (String(destination) === `${eventLogPath}.window.json`)
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return rename(source, destination);
  });
  send('failed one');
  send('failed two');
  await flushSessionEventLogWrites(eventLogPath);
  assert.deepEqual(fs.readFileSync(eventLogPath), before);
  assert.ok(before.length <= 200);
  fault.mockRestore();
  send('recovered');
  await flushSessionEventLogWrites(eventLogPath);
  assert.deepEqual(summaries(eventLogPath, '0', 10), ['first', 'second', 'recovered']);
  assert.equal(readSessionEventLog(eventLogPath, { cursor: '2' }).endCursor, '3');
  assert.ok(fs.statSync(eventLogPath).size <= 200);
});

test('the active cap admits an exact UTF-8 line and refuses a larger line', async () => {
  const eventLogPath = resolveSessionEventLogPath(mkdtempForTestSync('event-utf8-cap-'));
  const event = { kind: 'request.started' as const, ts: 'fixed', summary: 'é' };
  const line = `${JSON.stringify(Object.assign({ version: 1, ts: 'fixed', session: 'default' }, event))}\n`;
  const env = { AGENT_DEVICE_EVENT_LOG_MAX_BYTES: String(Buffer.byteLength(line)) };
  appendSessionEvent(eventLogPath, 'default', event, env);
  await flushSessionEventLogWrites(eventLogPath);
  appendSessionEvent(eventLogPath, 'default', { ...event, summary: 'éé' }, env);
  await flushSessionEventLogWrites(eventLogPath);
  assert.equal(fs.readFileSync(eventLogPath, 'utf8'), line);
});

test('a single serialized line at 16 MiB persists and one byte more is refused', async () => {
  const dir = mkdtempForTestSync('event-single-byte-limit-');
  const eventLogPath = resolveSessionEventLogPath(dir);
  const logPath = path.join(dir, 'diagnostics.ndjson');
  const max = 16 * 1024 * 1024;
  const env = { AGENT_DEVICE_EVENT_LOG_MAX_BYTES: String(max * 2) };
  const makeEvent = (keySize: number) => ({
    kind: 'request.started' as const,
    ts: 'fixed',
    details: { ['x'.repeat(keySize)]: 1 },
  });
  const serialize = (event: ReturnType<typeof makeEvent>) =>
    `${JSON.stringify(Object.assign({ version: 1, ts: 'fixed', session: 'default' }, event))}\n`;
  const overhead = Buffer.byteLength(serialize(makeEvent(1))) - 1;
  const exact = makeEvent(max - overhead);
  const line = serialize(exact);
  assert.equal(Buffer.byteLength(line), max);
  await withDiagnosticsScope({ debug: true, logPath }, async () => {
    appendSessionEvent(eventLogPath, 'default', exact, env);
    await flushSessionEventLogWrites(eventLogPath);
    appendSessionEvent(eventLogPath, 'default', makeEvent(max - overhead + 1), env);
    await flushSessionEventLogWrites(eventLogPath);
  });
  assert.equal(fs.readFileSync(eventLogPath, 'utf8'), line);
  const diagnostics = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((entry) => JSON.parse(entry));
  assert.deepEqual(
    diagnostics
      .filter((event) => event.phase === 'session_event_log_write_failed')
      .map((event) => [event.data.reason, event.data.operation]),
    [['entry-too-large', 'admission']],
  );
});

test('an active-file rename failure preserves bytes and a later event recovers the window', async () => {
  const dir = mkdtempForTestSync('event-active-rename-');
  const eventLogPath = resolveSessionEventLogPath(dir);
  const logPath = path.join(dir, 'diagnostics.ndjson');
  const env = { AGENT_DEVICE_EVENT_LOG_MAX_BYTES: '200' };
  const send = (summary: string) =>
    appendSessionEvent(
      eventLogPath,
      'default',
      {
        kind: 'request.started',
        ts: 'fixed',
        summary,
      },
      env,
    );
  send('first');
  send('second');
  await flushSessionEventLogWrites(eventLogPath);
  const before = fs.readFileSync(eventLogPath);
  const rename = fs.promises.rename.bind(fs.promises);
  const fault = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
    if (String(source) === eventLogPath)
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return rename(source, destination);
  });
  await withDiagnosticsScope({ debug: true, logPath }, async () => {
    send('failed');
    await flushSessionEventLogWrites(eventLogPath);
  });
  assert.deepEqual(fs.readFileSync(eventLogPath), before);
  assert.ok(before.length <= 200);
  assert.equal(fs.existsSync(resolveRotatedSessionEventLogPath(eventLogPath)), false);
  const diagnostics = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((entry) => JSON.parse(entry));
  assert.deepEqual(
    diagnostics
      .filter((event) => event.phase === 'session_event_log_write_failed')
      .map((event) => [event.data.reason, event.data.operation, event.data.errno]),
    [['maintenance-failed', 'rotation', 'EACCES']],
  );
  fault.mockRestore();
  send('recovered');
  await flushSessionEventLogWrites(eventLogPath);
  assert.deepEqual(fs.readFileSync(resolveRotatedSessionEventLogPath(eventLogPath)), before);
  assert.ok(fs.statSync(eventLogPath).size <= 200);
  assert.deepEqual(summaries(eventLogPath, '0', 10), ['first', 'second', 'recovered']);
  assert.equal(readSessionEventLog(eventLogPath, { cursor: '2' }).endCursor, '3');
});
