import { resolveCommandDispatchDisclosure } from '@agent-device/command-registry/registry';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { type AppError, discloseUnclassifiedDispatch } from '@agent-device/kernel/errors';

/**
 * Records whether a client-side failure of a daemon request can have reached the device. Before
 * the send nothing could have; once the request was sent (or answered, with only its artifacts
 * left to fetch) the daemon may have run it, so {@link resolveCommandDispatchDisclosure} decides,
 * as at the daemon's own request seam. A failure a producer already classified keeps its verdict.
 */
export function discloseRequestFailure(
  failure: AppError,
  req: DaemonWireRequest,
  sent: boolean,
): AppError {
  const verdict = sent ? resolveCommandDispatchDisclosure(req) : 'no';
  return verdict === undefined ? failure : discloseUnclassifiedDispatch(failure, verdict);
}
