import type { ReplayBackendId } from '@agent-device/ad-script';
import type { ReplayBackendDeclaration } from '@agent-device/contracts/replay-backend';
import { maestroReplayBackendDeclaration } from '@agent-device/maestro/replay-backend-declaration';

/**
 * The engine-free half of every registered replay backend (#3377), as `help` lists it. Kept apart
 * from the registry so reading a declaration adds nothing to the closure of the daemon routes
 * that only load backends. Keys come from the format grammar's vocabulary, and each declaration's
 * `id` is typed to its key, as each plugin's is in the registry, so help cannot describe a backend
 * other than the one its id loads.
 */
const REPLAY_BACKEND_DECLARATIONS: {
  readonly [TId in ReplayBackendId]: ReplayBackendDeclaration<TId>;
} = {
  maestro: maestroReplayBackendDeclaration,
};

export function getReplayBackendDeclaration(
  id: ReplayBackendId,
): ReplayBackendDeclaration<ReplayBackendId> {
  return REPLAY_BACKEND_DECLARATIONS[id];
}
