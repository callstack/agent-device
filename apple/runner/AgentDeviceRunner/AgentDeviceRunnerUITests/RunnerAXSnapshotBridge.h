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
///
/// `customActionLimit` bounds the per-element custom-action reads described on
/// `customActionNamesForElement:axClient:`; pass 0 to skip them entirely.
+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes
                                      deepExtensionCallLimit:(NSInteger)deepExtensionCallLimit
                                           customActionLimit:(NSInteger)customActionLimit
                                                    deadline:(nullable NSDate *)deadline;

/// Names of the element's UIAccessibilityCustomActions, or nil when it has
/// none.
///
/// One element per call on purpose. The bulk snapshot request cannot carry this
/// attribute: adding it makes testmanagerd's reply decoder reject the nested
/// arrays a custom action serializes into ("value for key 'NS.objects' was of
/// unexpected class 'NSArray'"), drop the reply, and time the request out after
/// ~65s instead of the usual ~110ms. Per-element reads use a different XPC
/// message and answer normally.
///
/// Reading is all we can do: the actions are not invocable from the runner.
/// XCUIElement exposes no custom-action API; XCAXClient_iOS's
/// performAction:onElement:value: answers kAXErrorCannotComplete for every AX
/// action number; setAttribute: on the custom-actions attribute reports success
/// and does nothing; parameterizedAttribute: answers kAXErrorNoValue; and the
/// raw AXUIElement C API cannot be aimed at app elements because
/// XCAccessibilityElement is token-based and answers nil for AXUIElement.
+ (nullable NSArray<NSString *> *)customActionNamesForElement:(id)element axClient:(id)axClient;

/// The shared AX client (`XCUIDevice.accessibilityInterface`), or nil when the
/// private interface is unavailable.
+ (nullable id)accessibilityClient;

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
                                      mergedLeaves:(nullable NSMutableArray<RunnerAXSnapshotFrontier *> *)mergedLeaves
                                          deadline:(nullable NSDate *)deadline;

@end

NS_ASSUME_NONNULL_END
