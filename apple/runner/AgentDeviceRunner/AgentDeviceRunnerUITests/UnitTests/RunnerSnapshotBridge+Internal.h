#import <Foundation/Foundation.h>
#import <TargetConditionals.h>

NS_ASSUME_NONNULL_BEGIN

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

// The snapshot bridge's read admission and reader queue, which RunnerSnapshotBridge.m defines for the
// runner unit bundle. The packaged runner omits UnitTests/. A read answers with what `read` returns,
// nil included.
NSDictionary * _Nullable RunnerSnapshotBridgeRead(NSDictionary *request,
                                                  NSUInteger budgetMs,
                                                  NSDictionary * _Nullable (^read)(void),
                                                  NSTimeInterval (^clock)(void));
dispatch_queue_t RunnerSnapshotBridgeReaderQueue(void);

#endif

NS_ASSUME_NONNULL_END
