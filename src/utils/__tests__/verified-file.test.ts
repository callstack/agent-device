import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  openVerifiedFileForAppend,
  openVerifiedFileForRead,
  openVerifiedFileForTruncate,
} from '../verified-file.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('creates, appends, reads, and truncates only through verified descriptors', () => {
  const pathname = fixturePath('regular');
  const append = openVerifiedFileForAppend(pathname);
  fs.writeSync(append, 'first');
  fs.closeSync(append);

  const read = openVerifiedFileForRead(pathname);
  expect(read).toBeTypeOf('number');
  expect(fs.readFileSync(read!, 'utf8')).toBe('first');
  fs.closeSync(read!);

  const truncate = openVerifiedFileForTruncate(pathname);
  fs.writeSync(truncate, 'second');
  fs.closeSync(truncate);
  expect(fs.readFileSync(pathname, 'utf8')).toBe('second');
});

test.each(['read', 'append', 'truncate'] as const)(
  'rejects a final symlink before %s and preserves its target',
  (operation) => {
    const pathname = fixturePath(operation);
    const outside = `${pathname}.outside`;
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, pathname);

    expect(() => {
      const descriptor =
        operation === 'read'
          ? openVerifiedFileForRead(pathname)
          : operation === 'append'
            ? openVerifiedFileForAppend(pathname)
            : openVerifiedFileForTruncate(pathname);
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }).toThrow('regular file');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  },
);

test('returns absent for a missing read without creating the file', () => {
  const pathname = fixturePath('missing');
  expect(openVerifiedFileForRead(pathname)).toBeUndefined();
  expect(fs.existsSync(pathname)).toBe(false);
});

function fixturePath(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-verified-${label}-`));
  roots.push(root);
  return path.join(root, 'artifact');
}
