#import "RunnerAXSnapshotBridge.h"

NS_ASSUME_NONNULL_BEGIN

/// The bridge's client, target, request, and attribute plumbing, shared with the other AX reads
/// so each private call has one implementation.
@interface RunnerAXSnapshotBridge ()

+ (nullable id)accessibilityApplicationForApplication:(XCUIApplication *)application axClient:(id)axClient;

/// The client's default snapshot parameters with the depth and node caps applied.
+ (NSMutableDictionary *)snapshotParametersForClient:(id)axClient
                                            maxDepth:(NSInteger)maxDepth
                                            maxNodes:(NSInteger)maxNodes;

/// The root element snapshot of one request, or nil with `error` set.
+ (nullable id)rootSnapshotFromClient:(id)axClient
                               target:(id)target
                           attributes:(NSArray *)attributes
                           parameters:(NSDictionary *)parameters
                                error:(NSError **)error;

/// Maps snapshot keypaths to AX attributes, keeping only attributes whose name ends with one of
/// `consumedSuffixes`.
+ (NSArray *)attributesForKeyPaths:(NSArray<NSString *> *)keyPaths
                  consumedSuffixes:(NSArray<NSString *> *)consumedSuffixes;

+ (nullable id)accessibilityElementForSnapshot:(id)snapshot;
+ (NSArray *)childrenForSnapshot:(id)snapshot;
+ (nullable NSNumber *)numberValueForKey:(NSString *)key snapshot:(id)snapshot;
+ (nullable NSString *)stringValueForKey:(NSString *)key snapshot:(id)snapshot;
+ (CGRect)frameForSnapshot:(id)snapshot;
+ (nullable id)objectFrom:(id)target selectorName:(NSString *)selectorName;
+ (NSInteger)integerFrom:(id)target selectorName:(NSString *)selectorName;

@end

NS_ASSUME_NONNULL_END
