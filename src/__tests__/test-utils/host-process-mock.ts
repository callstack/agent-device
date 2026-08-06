type HostProcessModule = typeof import('../../utils/host-process.ts');

/**
 * `vi.mock` factory for `utils/host-process.ts` in tests that seed a "live"
 * owner from the test process's own identity (readCurrentOwnerIdentity and
 * friends) and later have production code re-read it during classification.
 *
 * readProcessStartTime shells out to `ps` with a 1s timeout; under full-suite
 * CPU contention a re-read can miss that deadline and return null, mismatching
 * the seeded value and flipping a genuinely-live owner to 'owner-process-dead'.
 * This factory reads our own pid's start time once for real, then serves the
 * cached value so every read is self-consistent. Other pids read as null, same
 * as a real `ps` miss. isProcessAlive stays real (a plain `kill(pid, 0)`
 * syscall, not a subprocess), so fabricated dead-pid fixtures still classify
 * as dead through that non-flaky check.
 *
 * Usage: `vi.mock('<path>/utils/host-process.ts', async (importOriginal) =>
 * (await import('<path>/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(importOriginal))`
 */
// Consumed by three suites, but only through `(await import(...)).pinOwnProcessStartTime`
// inside `vi.mock` factories — vitest hoists those above static imports, so the dynamic
// form is required and fallow cannot trace the consumers statically.
// fallow-ignore-next-line unused-export
export async function pinOwnProcessStartTime(
  importOriginal: () => Promise<HostProcessModule>,
): Promise<HostProcessModule> {
  const actual = await importOriginal();
  let cachedOwnStartTime: string | null | undefined;
  return {
    ...actual,
    readProcessStartTime: (pid: number) => {
      if (pid !== process.pid) return null;
      if (cachedOwnStartTime === undefined) {
        cachedOwnStartTime = actual.readProcessStartTime(process.pid);
      }
      return cachedOwnStartTime;
    },
  };
}
