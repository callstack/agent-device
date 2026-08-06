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

/// A depth-capped childless node awaiting an element-rooted follow-up request.
/// Public so the runner unit bundle can drive the extension's miss paths with
/// fabricated snapshots — the executed contract that missed frontiers are
/// counted, never silently dropped.
@interface RunnerAXSnapshotFrontier : NSObject
@property(nonatomic, strong, nullable) id snapshot;
@property(nonatomic, strong, nullable) NSMutableDictionary *node;
@property(nonatomic, assign) NSInteger depth;
@end

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

/// The frontier-extension loop, exposed for the runner unit bundle: a frontier
/// whose element vanished or whose re-rooted request fails must count as
/// missed (see the deepExtension keys above) — an all-miss extension reporting
/// itself drained would present a capped capture as complete.
+ (nullable NSDictionary *)extendSnapshotFrontiers:(NSMutableArray<RunnerAXSnapshotFrontier *> *)frontiers
                                          axClient:(id)axClient
                                        attributes:(NSArray *)attributes
                                          maxDepth:(NSInteger)maxDepth
                                          maxNodes:(NSInteger)maxNodes
                                         nodeCount:(NSInteger *)nodeCount
                                         truncated:(BOOL *)truncated
                                      callsAllowed:(NSInteger)callsAllowed
                                          deadline:(nullable NSDate *)deadline;

@end

NS_ASSUME_NONNULL_END
