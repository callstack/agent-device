import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { createAndroidFileHost } from './__tests__/test-utils/android-file-host.ts';
import { mkdtempForTest } from './__tests__/test-utils/tmp-dir.ts';
import {
  clearAndroidTestImeFlushRecord,
  readAndroidTestImeFlushRecord,
  writeAndroidTestImeFlushRecord,
} from './ime-recovery-marker.ts';

const SERIAL = 'emulator-5554';
const RECORD = { deadlineMs: 1234.5, confirmed: true, writer: 'daemon-a' } as const;

beforeEach(() => {
  bindAndroidAdbHostStub({ files: createAndroidFileHost() });
});

test('a written flush record reads back from the state dir and clears', async () => {
  const stateDir = await mkdtempForTest('ime-flush-record-');

  await writeAndroidTestImeFlushRecord(stateDir, SERIAL, RECORD);
  expect(await readAndroidTestImeFlushRecord(stateDir, SERIAL)).toEqual(RECORD);

  await clearAndroidTestImeFlushRecord(stateDir, SERIAL);
  expect(await readAndroidTestImeFlushRecord(stateDir, SERIAL)).toBeUndefined();
});

test('a record naming another serial or version is not read as this device', async () => {
  const stateDir = await mkdtempForTest('ime-flush-record-');
  await writeAndroidTestImeFlushRecord(stateDir, SERIAL, RECORD);
  const file = path.join(stateDir, 'android-test-ime-flush', SERIAL);
  const stored = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;

  await fs.writeFile(file, JSON.stringify({ ...stored, serial: 'emulator-5556' }));
  expect(await readAndroidTestImeFlushRecord(stateDir, SERIAL)).toBeUndefined();

  await fs.writeFile(file, JSON.stringify({ ...stored, version: 2 }));
  expect(await readAndroidTestImeFlushRecord(stateDir, SERIAL)).toBeUndefined();
});
