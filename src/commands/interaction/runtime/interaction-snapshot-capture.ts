import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { now, toBackendContext } from '../../runtime-common.ts';

/**
 * A leaf shared by every interaction runtime module that needs a fresh (or session-cached) tree:
 * `resolution.ts`'s ref/selector resolution, `selector-readiness.ts`'s readiness poll,
 * `gestures.ts`'s viewport resolution, and `post-action-observation.ts`'s `--verify` baseline.
 * Deliberately self-contained — it imports no sibling of this directory, so those siblings can
 * import it without ever risking a cycle back.
 */

export type InteractionSnapshot = {
  snapshot: SnapshotState;
};

export async function captureInteractionSnapshot(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  interactiveOnly: boolean,
): Promise<InteractionSnapshot> {
  if (!runtime.backend.captureSnapshot) {
    throw new AppError('UNSUPPORTED_OPERATION', 'snapshot is not supported by this backend');
  }
  const sessionName = options.session ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', 'No active session. Run open first.');
  const result = await runtime.backend.captureSnapshot(toBackendContext(runtime, options), {
    interactiveOnly,
    includeRects: true,
  });
  const snapshot =
    result.snapshot ??
    ({
      nodes: result.nodes ?? [],
      truncated: result.truncated,
      backend: result.backend as SnapshotState['backend'],
      createdAt: now(runtime),
    } satisfies SnapshotState);
  await runtime.sessions.set({ ...session, snapshot });
  return { snapshot };
}
