type HostProcessModule = typeof import('../../utils/host-process.ts');
type HostProcessIdentityObservation =
  import('../../utils/host-process.ts').HostProcessIdentityObservation;

/**
 * `vi.mock` factory for `utils/host-process.ts` in tests that seed a "live"
 * owner from the test process's own identity (readCurrentOwnerIdentity and
 * friends) and later have production code re-read it during classification.
 *
 * readProcessStartTime shells out to `ps` with a 1s timeout; under full-suite
 * CPU contention a re-read can miss that deadline and return null, mismatching
 * the seeded value and flipping a genuinely-live owner to 'owner-process-dead'.
 * This factory assigns our own pid a stable synthetic start time, then serves
 * that value so every read is self-consistent without a subprocess. Other pids read as null, same
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
  const ownStartTime = 'test-process-start-time';
  return {
    ...actual,
    readProcessStartTime: (pid: number) => {
      if (pid !== process.pid) return null;
      return ownStartTime;
    },
    readHostProcessIdentityObservations: (pids: Iterable<number>) => {
      const selected = [...pids];
      const observations = new Map<number, HostProcessIdentityObservation>();
      if (selected.includes(process.pid)) {
        observations.set(process.pid, {
          state: 'S',
          startTime: ownStartTime,
        });
      }
      return observations;
    },
  };
}
