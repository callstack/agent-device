import type {
  AppLogCompletion,
  AppLogLiveHandle,
  AppLogLiveSnapshot,
  CleanupOutcome,
  FinishOutcome,
} from '@agent-device/contracts/platform';
import { createAppLogLiveHandle } from '@agent-device/capture-kit';

type AppLogLiveHandleImplementation = Readonly<{
  inspect(): AppLogLiveSnapshot;
  finish(): Promise<FinishOutcome<AppLogCompletion>>;
  forceCleanup(): Promise<CleanupOutcome>;
}>;

/** Test-only constructor for owners that need independently controlled finish and cleanup outcomes. */
export function createTestAppLogLiveHandle(
  implementation: AppLogLiveHandleImplementation,
): AppLogLiveHandle {
  return createAppLogLiveHandle(implementation);
}
