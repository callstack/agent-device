/**
 * What a helper teardown leaves standing for one device until an acquire looks again: a session
 * identity that should not start yet, or a release that was never proven. `retryAtMs` is the epoch
 * time when trying again is worth it, which is what a slow device or transport asks for; a state
 * without one stands until the device, or an acquire that reads it, settles it.
 */
export type AndroidSnapshotHelperRetryState<Value> = Readonly<{
  value: Value;
  retryAtMs?: number;
}>;

export function isAndroidSnapshotHelperRetryStateStanding(
  state: AndroidSnapshotHelperRetryState<unknown>,
  nowMs = Date.now(),
): boolean {
  return state.retryAtMs === undefined || nowMs < state.retryAtMs;
}
