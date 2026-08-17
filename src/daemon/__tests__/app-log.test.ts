import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { appendAppLogMarker, clearAppLogFiles, getAppLogPathMetadata } from '../app-log.ts';

test('marker and clear operations keep app-log file ownership in the daemon', () => {
  const root = mkdtempForTestSync('agent-device-app-log-files-');
  const outPath = path.join(root, 'session', 'app.log');

  appendAppLogMarker(outPath, 'checkpoint');
  fs.writeFileSync(`${outPath}.1`, 'rotated');

  expect(fs.readFileSync(outPath, 'utf8')).toMatch(/\[agent-device\]\[mark\].* checkpoint/);
  expect(getAppLogPathMetadata(outPath)).toMatchObject({ exists: true });
  expect(clearAppLogFiles(outPath)).toEqual({
    path: outPath,
    cleared: true,
    removedRotatedFiles: 1,
  });
  expect(fs.readFileSync(outPath, 'utf8')).toBe('');
  expect(fs.existsSync(`${outPath}.1`)).toBe(false);
});

test.each(['metadata', 'mark', 'clear'] as const)(
  'rejects a final app.log symlink before %s touches its target',
  (operation) => {
    const root = mkdtempForTestSync(`agent-device-app-log-${operation}-`);
    const outPath = path.join(root, 'session', 'app.log');
    const outsidePath = path.join(root, 'outside.log');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outsidePath, 'outside');
    fs.symlinkSync(outsidePath, outPath);

    // `mark` runs through ensureAppLogPath's own symlink guard ("must not be a symbolic
    // link"); `metadata` and `clear` go straight to the shared verified-file open path,
    // whose identity check reports the path as simply not a regular file.
    const expectedMessage =
      operation === 'mark' ? /must not be a symbolic link/ : /must be a regular file/;
    expect(() => {
      if (operation === 'metadata') getAppLogPathMetadata(outPath);
      else if (operation === 'mark') appendAppLogMarker(outPath, 'checkpoint');
      else clearAppLogFiles(outPath);
    }).toThrow(expectedMessage);
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe('outside');
    expect(fs.lstatSync(outPath).isSymbolicLink()).toBe(true);
  },
);
