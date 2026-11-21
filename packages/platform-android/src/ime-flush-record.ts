import path from 'node:path';
import { requireAndroidAdbHost } from './adb-host.ts';

// Durable test-IME flush deadlines, one file per device, in the daemon state dir. The record
// outlives the daemon process, so a restarted daemon still holds `adb emu kill` until a window
// a dead process opened has passed (#3346). ime-state.ts owns the clock and the window rules.
const FLUSH_RECORD_DIR = 'android-test-ime-flush';
const RECORD_VERSION = 1;

export type AndroidTestImeFlushRecord = Readonly<{
  /** Host monotonic time (ms) after which the provider's delayed write has landed. */
  deadlineMs: number;
  /** True only when a read-back confirmed the newest write. */
  confirmed: boolean;
  /** Token of the daemon process that wrote the record. */
  writer: string;
}>;

function flushRecordFile(stateDir: string, serial: string): string {
  return path.join(stateDir, FLUSH_RECORD_DIR, encodeURIComponent(serial));
}

export async function writeAndroidTestImeFlushRecord(
  stateDir: string,
  serial: string,
  record: AndroidTestImeFlushRecord,
): Promise<void> {
  const files = requireAndroidAdbHost().files;
  await files.ensureDirectory(path.join(stateDir, FLUSH_RECORD_DIR));
  await files.writeAtomicText(
    flushRecordFile(stateDir, serial),
    `${JSON.stringify({ version: RECORD_VERSION, serial, ...record })}\n`,
    0o600,
  );
}

export async function readAndroidTestImeFlushRecord(
  stateDir: string,
  serial: string,
): Promise<AndroidTestImeFlushRecord | undefined> {
  let raw: string;
  try {
    raw = await requireAndroidAdbHost().files.readText(flushRecordFile(stateDir, serial));
  } catch {
    return undefined;
  }
  return parseAndroidTestImeFlushRecord(raw, serial);
}

export async function clearAndroidTestImeFlushRecord(
  stateDir: string,
  serial: string,
): Promise<void> {
  await requireAndroidAdbHost()
    .files.remove(flushRecordFile(stateDir, serial), { force: true })
    .catch(() => {});
}

function parseAndroidTestImeFlushRecord(
  raw: string,
  serial: string,
): AndroidTestImeFlushRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.version === RECORD_VERSION &&
    record.serial === serial &&
    typeof record.deadlineMs === 'number' &&
    Number.isFinite(record.deadlineMs) &&
    typeof record.confirmed === 'boolean' &&
    typeof record.writer === 'string'
    ? { deadlineMs: record.deadlineMs, confirmed: record.confirmed, writer: record.writer }
    : undefined;
}
