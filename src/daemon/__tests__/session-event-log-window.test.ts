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
import {
  EVENT_LOG_CURSOR_EXPIRED_REASON,
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

test('rotation caps events.ndjson while cursors stay absolute across the retained window', async () => {
  const eventLogPath = resolveSessionEventLogPath(
    mkdtempForTestSync('agent-device-event-log-cap-'),
  );
  // One entry is ~110 bytes; a 1 KB cap rotates roughly every 9-10 entries, so
  // 40 entries force several rotations and at least one dropped generation.
  process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES = '1024';
  assert.equal(resolveSessionEventLogMaxBytes(), 1024);

  await appendEvents(eventLogPath, 0, 40);

  const rotatedPath = resolveRotatedSessionEventLogPath(eventLogPath);
  assert.equal(fs.existsSync(rotatedPath), true, 'expected a rotated generation');
  assert.ok(
    fs.statSync(eventLogPath).size <= 1024 + 200,
    `active file must stay near the cap, got ${fs.statSync(eventLogPath).size} bytes`,
  );
  const retainedLineCount = [rotatedPath, eventLogPath]
    .map((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length)
    .reduce((sum, count) => sum + count, 0);
  assert.ok(retainedLineCount < 40, `expected dropped events, retained ${retainedLineCount}`);

  // A cursor inside the retained window resumes at the same absolute event it
  // named before rotation, spanning the rotated and active files.
  const earliest = 40 - retainedLineCount;
  const page = readSessionEventLog(eventLogPath, { cursor: String(earliest), limit: 500 });
  assert.deepEqual(
    page.events.map((event) => event.summary),
    Array.from({ length: retainedLineCount }, (_, index) => `event ${earliest + index}`),
  );
  const tail = readSessionEventLog(eventLogPath, { cursor: '38', limit: 1 });
  assert.deepEqual(summaries(eventLogPath, '38', 1), ['event 38']);
  assert.equal(tail.nextCursor, '39');
  assert.deepEqual(summaries(eventLogPath, tail.nextCursor, 1), ['event 39']);

  // A cursor that fell off the window is a typed signal, not a wrong page.
  const expired = (() => {
    try {
      readSessionEventLog(eventLogPath, { cursor: '0' });
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(expired instanceof AppError, 'expected an AppError for an expired cursor');
  assert.equal(expired.code, 'COMMAND_FAILED');
  assert.equal(expired.details?.reason, EVENT_LOG_CURSOR_EXPIRED_REASON);
  assert.equal(expired.details?.earliestCursor, earliest);
  assert.equal(typeof expired.details?.hint, 'string');

  // The window survives further rotations: keep writing, and a live cursor
  // still resolves to the event it named.
  await appendEvents(eventLogPath, 40, 60);
  assert.deepEqual(summaries(eventLogPath, '58', 2), ['event 58', 'event 59']);
});

test('the default cap leaves an ordinary session log unrotated', async () => {
  const dir = mkdtempForTestSync('agent-device-event-log-default-cap-');
  const eventLogPath = resolveSessionEventLogPath(dir);
  delete process.env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES;

  await appendEvents(eventLogPath, 0, 3);

  assert.deepEqual(fs.readdirSync(dir), [path.basename(eventLogPath)]);
  assert.deepEqual(summaries(eventLogPath), ['event 0', 'event 1', 'event 2']);
});
