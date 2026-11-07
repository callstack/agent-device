#if defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)
#import "RunnerSnapshotBridgeTesting.h"

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

#import "RunnerSnapshotBridge+Internal.h"

NSDictionary *RunnerSnapshotBridgeReadForTest(NSDictionary *request, NSUInteger budgetMs,
                                               NSDictionary *(^read)(void), NSTimeInterval now)
{
  return RunnerSnapshotBridgeRead(request, budgetMs, read, ^{ return now; });
}

void RunnerSnapshotBridgeDrainForTest(void)
{
  dispatch_sync(RunnerSnapshotBridgeReaderQueue(), ^{});
}

#endif
#endif
