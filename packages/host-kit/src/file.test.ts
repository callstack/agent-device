import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ensurePrivateDirectorySync } from './file.ts';
import { mkdtempForTestSync } from './internal/tmp-dir.fixtures.ts';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempForTestSync(prefix);
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensurePrivateDirectorySync creates nested missing directories without touching existing ones', () => {
  const existing = createTempRoot('host-kit-private-dir-existing-');
  const nested = path.join(existing, 'a', 'b');
  const chmodSpy = vi.spyOn(fs, 'chmodSync');

  ensurePrivateDirectorySync(nested);
  expect(fs.statSync(nested).mode & 0o777).toBeTypeOf('number');
  if (process.platform === 'win32') {
    expect(chmodSpy).not.toHaveBeenCalled();
  } else {
    expect(chmodSpy.mock.calls.map(([target]) => target)).toEqual([
      path.join(existing, 'a'),
      nested,
    ]);
  }

  chmodSpy.mockClear();
  ensurePrivateDirectorySync(existing);
  ensurePrivateDirectorySync(nested);
  expect(chmodSpy).not.toHaveBeenCalled();
});

test('ensurePrivateDirectorySync skips chmod when concurrent creation wins with EEXIST', () => {
  const root = createTempRoot('host-kit-private-dir-eexist-');
  const raced = path.join(root, 'raced');
  const chmodSpy = vi.spyOn(fs, 'chmodSync');
  vi.spyOn(fs, 'mkdirSync').mockImplementationOnce((targetPath) => {
    fs.mkdirSync(String(targetPath), { mode: 0o755 });
    const error = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    throw error;
  });

  ensurePrivateDirectorySync(raced);
  expect(fs.statSync(raced).mode & 0o777).toBeTypeOf('number');
  expect(chmodSpy).not.toHaveBeenCalled();
});

test.skipIf(process.platform === 'win32').each([0o002, 0o700])(
  'ensurePrivateDirectorySync creates missing levels at 0o700 under umask %o without altering pre-existing dirs',
  (umaskValue) => {
    const root = createTempRoot('host-kit-private-dir-umask-');
    const preExistingParent = path.join(root, 'existing-parent');
    fs.mkdirSync(preExistingParent, { mode: 0o755 });
    fs.chmodSync(preExistingParent, 0o755);

    const preExistingUnsafe = path.join(root, 'existing-unsafe');
    fs.mkdirSync(preExistingUnsafe, { mode: 0o775 });
    fs.chmodSync(preExistingUnsafe, 0o775);

    const nestedTarget = path.join(preExistingParent, 'fresh-a', 'fresh-b');
    const previousUmask = process.umask(umaskValue);
    try {
      ensurePrivateDirectorySync(nestedTarget);
      ensurePrivateDirectorySync(preExistingUnsafe);
    } finally {
      process.umask(previousUmask);
    }

    expect(fs.statSync(preExistingParent).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(preExistingParent, 'fresh-a')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nestedTarget).mode & 0o777).toBe(0o700);
    expect(fs.statSync(preExistingUnsafe).mode & 0o777).toBe(0o775);
  },
);
