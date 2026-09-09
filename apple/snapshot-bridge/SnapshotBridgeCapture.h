#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef id _Nullable (^SnapshotElementReader)(id element, NSUInteger depth, NSUInteger nodes, NSError **error);

/// Materializes one bounded tree; retries bounded native acquisition failures and re-roots withheld children.
NSDictionary *_Nullable captureSnapshotTree(id element, NSUInteger maxDepth, NSUInteger maxNodes,
                                           SnapshotElementReader reader, BOOL *truncated, NSError **error);

NS_ASSUME_NONNULL_END
