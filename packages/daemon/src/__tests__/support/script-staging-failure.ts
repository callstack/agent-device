import fs from 'node:fs';
import { vi } from 'vitest';
import { isPublishTemporarySiblingOf } from '@agent-device/test-kit';

/**
 * Makes the staging write of a script publication fail, and only that write.
 *
 * A publication stages the recording in a private temp sibling of the destination and moves it into place,
 * so the seam where the filesystem can refuse a script is that one write. `test-kit`'s temp-path predicate
 * says which sibling it is, so the fixture does not have to know how the name is built.
 *
 * The write goes through the sibling's OPEN DESCRIPTOR, not through its name — which is what keeps a name
 * somebody else planted from being followed or emptied — so the fixture learns that descriptor as the
 * publish opens it and fails the write that carries it.
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
  const stagingDescriptors = new Set<number>();
  const realOpenSync = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike | number, ...rest) => {
    const descriptor = (realOpenSync as (...args: unknown[]) => number)(file, ...rest);
    if (isPublishTemporarySiblingOf(file, destination)) stagingDescriptors.add(descriptor);
    return descriptor;
  }) as typeof fs.openSync);
  // Descriptors are SMALL REUSED NUMBERS, so a set of them cannot outlive this publication: it is emptied
  // the moment the write is refused, which is the one write this fixture means to refuse.
  const failOnce = (descriptor: number): boolean => {
    if (!stagingDescriptors.delete(descriptor)) return false;
    stagingDescriptors.clear();
    return true;
  };
  const realWriteFileSync = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathLike | number, ...rest) => {
    if (typeof file === 'number') {
      if (failOnce(file)) throw failure;
    } else if (isPublishTemporarySiblingOf(file, destination)) {
      stagingDescriptors.clear();
      throw failure;
    }
    return (realWriteFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.writeFileSync);
}
