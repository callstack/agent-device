#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
NS_ASSUME_NONNULL_BEGIN
#if TARGET_OS_IOS && TARGET_OS_SIMULATOR
NSDictionary *RunnerSnapshotBridgeReadForTest(NSDictionary *request, NSUInteger budgetMs,
                                               NSDictionary *(^read)(void), NSTimeInterval now);
void RunnerSnapshotBridgeDrainForTest(void);
#endif
NS_ASSUME_NONNULL_END
