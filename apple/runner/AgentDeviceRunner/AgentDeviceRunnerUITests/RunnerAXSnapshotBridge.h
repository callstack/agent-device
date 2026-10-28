#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <XCTest/XCTest.h>

NS_ASSUME_NONNULL_BEGIN

/// Keys of the `deepExtension` dictionary in the snapshot response, shared with the Swift consumer
/// so the response shape has one spelling.
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionCallsKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionNodesAddedKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionPendingKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotDeepExtensionMissedKey;

/// Keys of the `customActions` dictionary in the snapshot response: how many merged elements were
/// eligible for an action read, and how many the bounded pass actually reached. Present only when
/// the capture asked for actions.
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotCustomActionsKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotCustomActionsReadKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotCustomActionsCandidatesKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotCustomActionsTruncatedKey;
FOUNDATION_EXPORT NSString *const RunnerAXSnapshotCustomActionsBlockedKey;

/// A depth-capped childless node awaiting an element-rooted follow-up request. Public so the runner
/// unit bundle can drive the extension's miss paths with fabricated snapshots.
@interface RunnerAXSnapshotFrontier : NSObject
@property(nonatomic, strong, nullable) id snapshot;
@property(nonatomic, strong, nullable) NSMutableDictionary *node;
@property(nonatomic, assign) NSInteger depth;
@end

@interface RunnerAXSnapshotBridge : NSObject

/// Captures the app's accessibility tree, then chains element-rooted follow-up requests from
/// depth-capped frontier nodes: the AX depth limit is per-request, so re-rooting reaches content
/// the app-rooted request could not. The response gains a `deepExtension` {calls, nodesAdded,
/// pendingFrontiers, missedFrontiers} dictionary when any frontier existed and the call limit
/// allowed extension. Pass 0 to disable extension entirely. `customActionLimit` bounds the
/// per-element custom-action reads; pass 0 to skip them entirely.
+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes
                                      deepExtensionCallLimit:(NSInteger)deepExtensionCallLimit
                                           customActionLimit:(NSInteger)customActionLimit
                                                    deadline:(nullable NSDate *)deadline;

/// The capture behind `snapshotTreeForApplication:`, for an AX client and target application
/// element that are already resolved. Every request, extension, and custom-action decision happens
/// here; the application entry point only resolves the two identities.
+ (NSDictionary<NSString *, id> *)snapshotTreeWithClient:(id)axClient
                                                  target:(id)target
                                                maxDepth:(NSInteger)maxDepth
                                                maxNodes:(NSInteger)maxNodes
                                  deepExtensionCallLimit:(NSInteger)deepExtensionCallLimit
                                       customActionLimit:(NSInteger)customActionLimit
                                                deadline:(nullable NSDate *)deadline;

/// Names of the element's UIAccessibilityCustomActions, or nil when it has none. One element per
/// call on purpose: the bulk snapshot request cannot carry this attribute — its nested arrays make
/// testmanagerd's reply decoder drop the reply and time the request out — while per-element reads
/// use a different XPC message and answer normally. Reading is all this does: none of the
/// invocation routes work from the runner (XCUIElement exposes no API, XCAXClient_iOS
/// performAction:onElement:value: answers kAXErrorCannotComplete, setAttribute: silently no-ops,
/// and the raw AXUIElement C API cannot be aimed at app elements).
+ (nullable NSArray<NSString *> *)customActionNamesForElement:(id)element
                                                    axClient:(id)axClient
                                                   completed:(BOOL *)completed;

/// Bounds one element's action list (max actions, max name length) and reports whether anything
/// was clipped, so a clipped list is disclosed rather than silently presented as a complete list.
+ (NSArray<NSString *> *)cappedActionNames:(NSArray<NSString *> *)names
                                 truncated:(BOOL *)truncated;

/// The bounded read pass over merged leaves, exposed for the runner unit bundle: the containment
/// contract (a hung read blocks the pass, is disclosed, and adds no further dispatches) is only
/// executable from here. Returns {read, candidates, truncated, blocked}.
+ (NSDictionary<NSString *, NSNumber *> *)
    annotateCustomActionsOnMergedLeaves:(nullable NSArray<RunnerAXSnapshotFrontier *> *)leaves
                               axClient:(id)axClient
                                  limit:(NSInteger)limit
                              rootFrame:(CGRect)rootFrame
                               deadline:(nullable NSDate *)deadline;

/// Reads dispatched but not yet returned. The AX call cannot be cancelled, so a read that blew its
/// deadline stays counted here until it returns — the state in which further reads are refused
/// rather than queued behind it.
+ (NSInteger)customActionReadsInFlight;

/// Total reads ever dispatched.
+ (NSInteger)customActionReadDispatchCount;

/// Total reads refused by single-flight admission.
+ (NSInteger)customActionReadBlockedCount;

/// The shared AX client (`XCUIDevice.accessibilityInterface`), or nil when the private interface is
/// unavailable.
+ (nullable id)accessibilityClient;

+ (NSInteger)processIdentifierForApplication:(XCUIApplication *)application;

/// Pids of the applications the AX client currently reports as active. Same private accessor the
/// snapshot target match uses; pids only — the client resolves no bundle id for an arbitrary app.
+ (NSArray<NSNumber *> *)activeApplicationProcessIdentifiers;

/// The frontier-extension loop, exposed for the runner unit bundle: a frontier whose element
/// vanished or whose re-rooted request fails must count as missed, never as drained.
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
