#import <Foundation/Foundation.h>
#import <XCTest/XCTest.h>

NS_ASSUME_NONNULL_BEGIN

@interface RunnerAXSnapshotBridge : NSObject

+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes;

/// Same as above, plus chained element-rooted follow-up requests from
/// depth-capped frontier nodes (the AX depth limit is per-request, so
/// re-rooting reaches content the app-rooted request could not). The response
/// gains a `deepExtension` {calls, nodesAdded, pendingFrontiers} dictionary
/// when any frontier existed and calls were allowed.
+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes
                                          deepExtensionCalls:(NSInteger)deepExtensionCalls
                                                    deadline:(nullable NSDate *)deadline;

+ (NSInteger)processIdentifierForApplication:(XCUIApplication *)application;

@end

NS_ASSUME_NONNULL_END
