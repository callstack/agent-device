import fs from 'node:fs';
import { vi } from 'vitest';

/** Some other local user: not the one running the suite, and not root. */
export const FOREIGN_UID = 65534;

/**
 * Reports the ids in `owners` for the paths named there, and the real host for every other path, so an
 * ownership rule is decided by the fixture rather than by the account the suite happens to run under.
 *
 * Only the ids move: modes and inode numbers stay what they are on disk. A real foreign owner needs
 * privileges a test does not have — an unprivileged process cannot `chown` to another uid — and moving
 * the CALLER's uid instead decides the test by which directories the scratch tree happens to sit under.
 */
export function serveHostOwnership(owners: Readonly<Record<string, number>>): void {
  const realLstat = fs.lstatSync.bind(fs);
  const realStat = fs.statSync.bind(fs);
  const reuid = (stats: fs.Stats, pathname: string): fs.Stats => {
    const uid = owners[pathname];
    if (uid === undefined || stats.uid === uid) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid }) as fs.Stats;
  };
  vi.spyOn(fs, 'lstatSync').mockImplementation(((pathname: never, ...rest: never[]) =>
    reuid(realLstat(pathname, ...rest), String(pathname))) as typeof fs.lstatSync);
  vi.spyOn(fs, 'statSync').mockImplementation(((pathname: never, ...rest: never[]) =>
    reuid(realStat(pathname, ...rest), String(pathname))) as typeof fs.statSync);
}
