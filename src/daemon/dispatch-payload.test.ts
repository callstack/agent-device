import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readNotificationPayload } from './dispatch-payload.ts';
import { mkdtempForTest } from '../__tests__/test-utils/tmp-dir.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtempForTest('dispatch-payload-');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writePayloadFile(name: string, contents: string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, contents, 'utf8');
  return filePath;
}

function expectInvalidArgs(promise: Promise<unknown>, messageFragment: string) {
  return expect(promise).rejects.toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

describe('readNotificationPayload inline input', () => {
  test('parses an inline JSON object', async () => {
    await expect(readNotificationPayload('{"aps":{"alert":"hi"}}')).resolves.toEqual({
      aps: { alert: 'hi' },
    });
  });

  test('rejects an inline JSON array because the payload must be an object', async () => {
    await expectInvalidArgs(
      readNotificationPayload('[1, 2, 3]'),
      'push payload must be a JSON object',
    );
  });

  test('rejects malformed inline JSON', async () => {
    await expectInvalidArgs(readNotificationPayload('{not json}'), 'Invalid push payload JSON');
  });
});

describe('readNotificationPayload file input', () => {
  test('reads and parses a JSON object from a file', async () => {
    const filePath = await writePayloadFile('payload.json', '{"foo":"bar","n":1}');
    await expect(readNotificationPayload(filePath)).resolves.toEqual({ foo: 'bar', n: 1 });
  });

  test('rejects a file whose contents are not valid JSON', async () => {
    const filePath = await writePayloadFile('broken.json', 'this is not json');
    await expectInvalidArgs(readNotificationPayload(filePath), 'Invalid push payload JSON');
  });

  test('rejects a file that contains a non-object JSON value', async () => {
    const filePath = await writePayloadFile('array.json', '[1,2,3]');
    await expectInvalidArgs(
      readNotificationPayload(filePath),
      'push payload must be a JSON object',
    );
  });

  test('reports a clear error when the payload path does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    await expectInvalidArgs(readNotificationPayload(missing), 'file not found');
  });

  test('reports a clear error when the payload path is a directory', async () => {
    await expectInvalidArgs(readNotificationPayload(tmpDir), 'not a file');
  });
});
