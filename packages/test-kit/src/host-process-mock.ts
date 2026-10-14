type HostProcessModule = typeof import('@agent-device/host-kit/process');
type HostProcessIdentityObservation =
  import('@agent-device/host-kit/process').HostProcessIdentityObservation;

export async function pinOwnProcessStartTime(
  importOriginal: () => Promise<HostProcessModule>,
): Promise<HostProcessModule> {
  const actual = await importOriginal();
  const ownStartTime = 'test-process-start-time';
  return {
    ...actual,
    readCurrentOwnerIdentity: () => ({ pid: process.pid, startTime: ownStartTime }),
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
