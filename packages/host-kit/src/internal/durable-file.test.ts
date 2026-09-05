import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { isAtomicPublishTemporaryPath } from './atomic-file.ts';
import { publishDurableFileSync } from './durable-file.ts';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('fsyncs complete contents before publication and uses the requested mode', () => {
  const root = fixtureRoot('ordering');
  const destination = path.join(root, 'record.json');
  const events: string[] = [];
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
    events.push('fsync');
    return realFsync(descriptor);
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    events.push('publish');
    return realRename(source, target);
  });

  publishDurableFileSync({ destination, contents: 'durable\n', mode: 0o640 });

  expect(fs.readFileSync(destination, 'utf8')).toBe('durable\n');
  expect(fs.statSync(destination).mode & 0o777).toBe(0o640);
  expect(events.indexOf('fsync')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('fsync')).toBeLessThan(events.indexOf('publish'));
  expect(temporaryPaths(root, destination)).toEqual([]);
});

test.each(['symbolic link', 'non-regular path'] as const)(
  'refuses a final %s and removes the temporary file',
  (kind) => {
    const root = fixtureRoot(kind);
    const destination = path.join(root, 'record.json');
    if (kind === 'symbolic link') {
      const outside = path.join(root, 'outside.json');
      fs.writeFileSync(outside, 'outside');
      fs.symlinkSync(outside, destination);
    } else {
      fs.mkdirSync(destination);
    }

    expect(() => publishDurableFileSync({ destination, contents: 'replacement' })).toThrow(
      kind === 'symbolic link' ? /symbolic link/ : /not a regular file/,
    );
    expect(temporaryPaths(root, destination)).toEqual([]);
  },
);

test('keeps an existing destination on link-exclusive publication failure', () => {
  const root = fixtureRoot('exclusive');
  const destination = path.join(root, 'record.json');
  fs.writeFileSync(destination, 'original');

  expect(() =>
    publishDurableFileSync({
      destination,
      contents: 'replacement',
      publish: 'link-exclusive',
    }),
  ).toThrow(/EEXIST/);
  expect(fs.readFileSync(destination, 'utf8')).toBe('original');
  expect(temporaryPaths(root, destination)).toEqual([]);
});

test('preserves the publication error while cleaning the temporary file', () => {
  const root = fixtureRoot('publish-error');
  const destination = path.join(root, 'record.json');
  const primary = new Error('publication failed');
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw primary;
  });

  assert.throws(
    () => publishDurableFileSync({ destination, contents: 'durable' }),
    (error: unknown) => error === primary,
  );
  expect(temporaryPaths(root, destination)).toEqual([]);
});

test('preserves a file fsync error when descriptor cleanup also fails', () => {
  const root = fixtureRoot('close-error');
  const destination = path.join(root, 'record.json');
  const primary = new Error('file fsync failed');
  const secondary = new Error('descriptor close failed');
  const realClose = fs.closeSync;
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
    throw primary;
  });
  vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
    realClose(descriptor);
    throw secondary;
  });

  assert.throws(
    () => publishDurableFileSync({ destination, contents: 'durable' }),
    (error: unknown) => error === primary,
  );
  expect(temporaryPaths(root, destination)).toEqual([]);
});

function fixtureRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-durable-file-${label}-`));
  roots.push(root);
  return root;
}

function temporaryPaths(root: string, destination: string): string[] {
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((pathname) => isAtomicPublishTemporaryPath(pathname, destination));
}
