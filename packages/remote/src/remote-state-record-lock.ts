import { acquireProcessLock, withProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';

/**
 * The shared helpers of the small record stores a client keeps under its remote-connections state
 * directory (session scripts, capture grants). This module loads only on demand: its lock imports
 * must not become an eager edge of `remote-connection-state.ts`, which the CLI evaluates at startup.
 */

/** Base-URL comparison form: a trailing slash is the same endpoint. */
export function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/**
 * The one process lock a remote-connections state record owner runs its read-modify-write under,
 * so two CLI processes never interleave a sweep, an admission decision, or a record write.
 */
export async function withRemoteStateLock<T>(
  params: Readonly<{ lockDirPath: string; description: string; timeoutMs: number }>,
  task: () => Promise<T>,
): Promise<T> {
  const { pid, startTime } = readCurrentOwnerIdentity();
  return await withProcessLock({
    acquire: () =>
      acquireProcessLock({
        lockDirPath: params.lockDirPath,
        owner: { pid, startTime, acquiredAtMs: Date.now() },
        timeoutMs: params.timeoutMs,
        description: params.description,
      }),
    task,
  });
}
