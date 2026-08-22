import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { assertThrowsAppError } from '../../__tests__/test-utils/app-error.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { ensureAppLogPath, rotateAppLogIfNeeded } from '../app-log-files.ts';

// Pinned as a literal on purpose — see the note in verified-file.test.ts.
const NOT_REGULAR_FILE_HINT =
  'agent-device only reads and writes regular files at this path. Remove the symbolic link or special file there and retry.';

test('rotateAppLogIfNeeded rotates files and discards the oldest generation', () => {
  const root = mkdtempForTestSync('agent-device-app-log-rotate-');
  const outPath = path.join(root, 'app.log');
  fs.writeFileSync(outPath, 'a'.repeat(20));
  fs.writeFileSync(`${outPath}.1`, 'old1');
  fs.writeFileSync(`${outPath}.2`, 'old2');

  rotateAppLogIfNeeded(outPath, { maxBytes: 10, maxRotatedFiles: 2 });

  expect(fs.existsSync(outPath)).toBe(false);
  expect(fs.readFileSync(`${outPath}.1`, 'utf8')).toHaveLength(20);
  expect(fs.readFileSync(`${outPath}.2`, 'utf8')).toBe('old1');
});

test('ensureAppLogPath applies configured rotation and creates the parent directory', () => {
  const root = mkdtempForTestSync('agent-device-app-log-ensure-');
  const outPath = path.join(root, 'session', 'app.log');
  ensureAppLogPath(outPath, {});
  expect(fs.existsSync(path.dirname(outPath))).toBe(true);

  fs.writeFileSync(outPath, 'content');
  ensureAppLogPath(outPath, {
    AGENT_DEVICE_APP_LOG_MAX_BYTES: '1',
    AGENT_DEVICE_APP_LOG_MAX_FILES: '1',
  });
  expect(fs.readFileSync(`${outPath}.1`, 'utf8')).toBe('content');
});

test('rotation rejects a final app.log symlink without touching its target', () => {
  const root = mkdtempForTestSync('agent-device-app-log-rotate-symlink-');
  const outPath = path.join(root, 'app.log');
  const outsidePath = path.join(root, 'outside.log');
  fs.writeFileSync(outsidePath, 'outside');
  fs.symlinkSync(outsidePath, outPath);

  assertThrowsAppError(() => rotateAppLogIfNeeded(outPath, { maxBytes: 1, maxRotatedFiles: 1 }), {
    code: 'COMMAND_FAILED',
    message: /must not be a symbolic link/,
    hint: NOT_REGULAR_FILE_HINT,
  });
  expect(fs.readFileSync(outsidePath, 'utf8')).toBe('outside');
  expect(fs.lstatSync(outPath).isSymbolicLink()).toBe(true);
});
