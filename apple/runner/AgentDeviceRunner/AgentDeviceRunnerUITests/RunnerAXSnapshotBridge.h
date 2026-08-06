#import <Foundation/Foundation.h>
#import <XCTest/XCTest.h>

NS_ASSUME_NONNULL_BEGIN

/// Keys of the `deepExtension` dictionary in the snapshot response, shared
/// with the Swift consumer so the response shape has one spelling.
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionCallsKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionNodesAddedKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionPendingKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionMissedKey;

@interface RunnerAXSnapshotBridge : NSObject

/// Captures the app's accessibility tree, then chains element-rooted follow-up
/// requests from depth-capped frontier nodes (the AX depth limit is
/// per-request, so re-rooting reaches content the app-rooted request could
/// not). The response gains a `deepExtension` {calls, nodesAdded,
/// pendingFrontiers, missedFrontiers} dictionary when any frontier existed and
/// the call limit allowed extension. Pass 0 to disable extension entirely.
+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes
                                      deepExtensionCallLimit:(NSInteger)deepExtensionCallLimit
                                                    deadline:(nullable NSDate *)deadline;

+ (NSInteger)processIdentifierForApplication:(XCUIApplication *)application;

@end

NS_ASSUME_NONNULL_END
