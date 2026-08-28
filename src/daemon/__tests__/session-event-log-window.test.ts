import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
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
  if (originalMaxBytes === undefined) delete process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES;
  else process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = originalMaxBytes;
});

async function appendEvents(eventLogPath: string, from: number, to: number): Promise<void> {
  for (let index = from; index < to; index += 1) {
    appendSessionEvent(eventLogPath, 'default', {
      kind: 'request.started',
      command: 'snapshot',
      summary: `event ${index}`,
    });
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
  assert.equal(resolveSessionEventLogMaxBytes(), 1024);

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
  assert.equal(resolveSessionEventLogMaxBytes(), 5 * 1024 * 1024);

  await appendEvents(eventLogPath, 0, 3);

  assert.deepEqual(fs.readdirSync(dir), [path.basename(eventLogPath)]);
  assert.deepEqual(summaries(eventLogPath), ['event 0', 'event 1', 'event 2']);
});
