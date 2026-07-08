import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import { PNG } from '../png.ts';
import { readPngSize } from '../png-size.ts';

test('readPngSize reads PNG dimensions from the file header', async () => {
  const filePath = tmpPngPath('size');
  fs.writeFileSync(filePath, PNG.sync.write(new PNG({ width: 17, height: 23 })));

  assert.deepEqual(await readPngSize(filePath), { width: 17, height: 23 });
});

test('readPngSize rejects malformed PNG files', async () => {
  const filePath = tmpPngPath('malformed');
  fs.writeFileSync(filePath, Buffer.alloc(0));

  await assert.rejects(readPngSize(filePath), (error) => {
    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).code, 'COMMAND_FAILED');
    return true;
  });
});

function tmpPngPath(prefix: string): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-png-${prefix}-`)),
    'image.png',
  );
}
