import fs from 'node:fs';

/**
 * The device and inode an `lstat` answer names. BIGINT stats: a numeric `ino` cannot hold every inode a
 * filesystem hands out, so two distinct large inodes would collapse onto one identity.
 */
export function identityOf(stats: fs.BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

/** The only lookup this rule makes: `lstat` with bigint ids, absence as `undefined`. */
export function lstatEntry(pathname: string): fs.BigIntStats | undefined {
  return fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
}

/** `lstat` that treats absence as `undefined`; every other errno propagates. */
export function lstatIfPresent(pathname: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
