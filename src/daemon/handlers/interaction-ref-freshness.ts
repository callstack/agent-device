import type { InteractionTarget } from '../../contracts/interaction.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { publicPlatformString } from '../../kernel/device.ts';
import { findNodeByRef, normalizeRef } from '../../kernel/snapshot.ts';
import { localIdentitiesEqual, readNodeLocalIdentity } from '../../replay/target-identity-node.ts';
import { STALE_REF_HINT } from '../../selectors/index.ts';
import { isSparseSnapshotQualityVerdict } from '../../snapshot/snapshot-quality.ts';
import { resolveRectCenter } from '../../utils/rect-center.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { errorResponse } from './response.ts';

/**
 * iOS has no Android-style post-navigation freshness marker. Once a previous
 * capture has made client refs stale, validate the saved node identity against
 * one current capture before allowing its cached coordinates to dispatch.
 */
export async function validateStaleIosRefBeforeTouch(params: {
  handler: InteractionHandlerParams & { captureSnapshotForSession: CaptureSnapshotForSession };
  session: SessionState;
  target: Extract<InteractionTarget, { kind: 'ref' }>;
  staleRefsWarning: string | undefined;
}): Promise<DaemonResponse | null> {
  const { handler, session, target, staleRefsWarning } = params;
  if (staleRefsWarning === undefined || publicPlatformString(session.device) !== 'ios') {
    return null;
  }

  const ref = normalizeRef(target.ref);
  const storedNode = ref ? findNodeByRef(session.snapshot?.nodes ?? [], ref) : null;

  try {
    const currentSnapshot = await handler.captureSnapshotForSession(
      session,
      handler.req.flags,
      handler.sessionStore,
      handler.contextFromFlags,
      { interactiveOnly: true, includeRects: true, store: false },
    );
    const currentNode = ref ? findNodeByRef(currentSnapshot.nodes, ref) : null;
    const storedCenter = resolveRectCenter(storedNode?.rect);
    const currentCenter = resolveRectCenter(currentNode?.rect);
    const sameIdentity =
      storedNode !== null &&
      currentNode !== null &&
      storedCenter !== null &&
      currentCenter !== null &&
      localIdentitiesEqual(readNodeLocalIdentity(storedNode), readNodeLocalIdentity(currentNode)) &&
      storedCenter.x === currentCenter.x &&
      storedCenter.y === currentCenter.y;

    if (sameIdentity && !isSparseSnapshotQualityVerdict(currentSnapshot.snapshotQuality)) {
      return null;
    }
    return staleRefError(target.ref);
  } catch (error) {
    return { ok: false as const, error: normalizeError(error) };
  }
}

function staleRefError(ref: string): DaemonResponse {
  return errorResponse('COMMAND_FAILED', `Ref ${ref} not found or has no bounds`, {
    hint: STALE_REF_HINT,
  });
}
