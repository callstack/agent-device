import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';

// The recovery hints are pinned as literals, not imported from the module under test: an
// assertion that compares the constant to itself stays green when the constant is deleted or
// reworded, which is the whole behaviour #1792 adds (ADR 0010 — errors say how to recover).
const NOT_REGULAR_FILE_HINT =
  'agent-device only reads and writes regular files at this path. Remove the symbolic link or special file there and retry.';
const CONCURRENT_REPLACEMENT_HINT =
  'Another process replaced the file at this path while it was being opened. Stop the concurrent writer, then retry.';
import {
  openVerifiedFileForAppend,
  openVerifiedFileForRead,
  openVerifiedFileForTruncate,
} from './verified-file.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

    assertThrowsAppError(
      () => {
        const descriptor =
          operation === 'read'
            ? openVerifiedFileForRead(pathname)
            : operation === 'append'
              ? openVerifiedFileForAppend(pathname)
              : openVerifiedFileForTruncate(pathname);
        if (descriptor !== undefined) fs.closeSync(descriptor);
      },
      { code: 'COMMAND_FAILED', message: /must be a regular file/, hint: NOT_REGULAR_FILE_HINT },
    );
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  },
);

// The two race guards cannot be reached from the filesystem alone, so the interleaving is
// planted: the path is swapped between the open and its post-open lstat, or the create keeps
// losing to a concurrent creator. Both must surface as typed failures with a recovery hint.
test('reports a typed failure when the file is swapped while it is being opened', () => {
  const pathname = fixturePath('swapped');
  const other = `${pathname}.other`;
  fs.writeFileSync(pathname, 'first');
  fs.writeFileSync(other, 'second');
  const realLstat = fs.lstatSync;
  let lstatCalls = 0;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
    lstatCalls += 1;
    // The second lstat is the post-open identity check; answer it with the other file.
    const resolved = lstatCalls === 2 ? other : target;
    return (realLstat as (path: fs.PathLike, options?: unknown) => fs.Stats)(resolved, options);
  }) as typeof fs.lstatSync);

  assertThrowsAppError(() => openVerifiedFileForRead(pathname), {
    code: 'COMMAND_FAILED',
    message: /identity changed while it was opened/,
    hint: CONCURRENT_REPLACEMENT_HINT,
  });
});

test('reports a typed failure when a create keeps losing the identity race', () => {
  const pathname = fixturePath('contended');
  const eexist = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
  vi.spyOn(fs, 'openSync').mockImplementation(() => {
    throw eexist;
  });

  assertThrowsAppError(() => openVerifiedFileForAppend(pathname), {
    code: 'COMMAND_FAILED',
    message: /could not be opened without an identity race/,
    hint: CONCURRENT_REPLACEMENT_HINT,
  });
});

test('returns absent for a missing read without creating the file', () => {
  const pathname = fixturePath('missing');
  expect(openVerifiedFileForRead(pathname)).toBeUndefined();
  expect(fs.existsSync(pathname)).toBe(false);
});

function fixturePath(label: string): string {
  const root = mkdtempForTestSync(`agent-device-verified-${label}-`);
  roots.push(root);
  return path.join(root, 'artifact');
}

function assertThrowsAppError(
  fn: () => unknown,
  expected: Readonly<{ code: string; message?: RegExp; hint?: string }>,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, expected.code);
    if (expected.message) assert.match(error.message, expected.message);
    if (expected.hint !== undefined) assert.equal(normalizeError(error).hint, expected.hint);
    return true;
  });
}

/**
 * Swaps the regular file at argv[2] for a FIFO between the helper's `lstat` and its open, then reports
 * whether the verified open refused it. Run in a child, so a blocking open fails the test at a deadline
 * instead of hanging the worker.
 */
const FIFO_SWAP_PROBE = `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [helper, target] = process.argv.slice(1);
const lstat = fs.lstatSync.bind(fs);
let swapped = false;
fs.lstatSync = (pathname, options) => {
  const seen = lstat(pathname, options);
  if (!swapped && pathname === target) {
    swapped = true;
    fs.rmSync(target);
    execFileSync('mkfifo', [target]);
  }
  return seen;
};
const { openVerifiedFileForRead } = await import(pathToFileURL(helper).href);
try {
  const descriptor = openVerifiedFileForRead(target);
  console.log(JSON.stringify({ swapped, outcome: 'opened', descriptor }));
} catch (error) {
  console.log(JSON.stringify({ swapped, outcome: 'refused', name: error?.constructor?.name, code: error?.code }));
}
`;

test.skipIf(process.platform === 'win32')(
  'a FIFO swapped in after the lstat is refused at once instead of waiting for a writer',
  () => {
    const directory = mkdtempForTestSync('verified-file-fifo-');
    const target = path.join(directory, 'journey.ad');
    fs.writeFileSync(target, 'v1\n');

    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        FIFO_SWAP_PROBE,
        path.join(import.meta.dirname, 'verified-file.ts'),
        target,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );

    // A blocking open never returns: the deadline kills the child and the signal says so.
    expect(probe.signal).toBeNull();
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout.trim())).toMatchObject({
      swapped: true,
      outcome: 'refused',
      name: 'AppError',
    });
  },
);
