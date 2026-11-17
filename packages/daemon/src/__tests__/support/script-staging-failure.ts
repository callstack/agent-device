import fs from 'node:fs';
import { vi } from 'vitest';
import { isPublishTemporarySiblingOf } from '@agent-device/test-kit';

/**
 * Makes the staging write of a script publication fail, and only that write.
 *
 * A publication stages the recording in a private temp sibling of the destination and moves it into place,
 * so the seam where the filesystem can refuse a script is that one write. `test-kit`'s temp-path predicate
 * says which write it is, so the fixture does not have to know how the name is built.
 *
 * This replaces a fixture that made the destination's directory `0500`. That one asked the HOST whether a
 * write into it is allowed, and a caller the mode bits do not bind — root — writes straight through it, so
 * the write succeeded and the test that expected a failure failed with it. The failure injected here is the
 * fixture's own, which makes the outcome the same for every caller.
 */
export function failScriptStagingWrite(destination: string): void {
  const failure: NodeJS.ErrnoException = Object.assign(
    new Error(`EACCES: permission denied, open '${destination}'`),
    { code: 'EACCES', errno: -13, syscall: 'open', path: destination },
  );
  const realWriteFileSync = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathLike | number, ...rest) => {
    if (isPublishTemporarySiblingOf(file, destination)) throw failure;
    return (realWriteFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.writeFileSync);
}
