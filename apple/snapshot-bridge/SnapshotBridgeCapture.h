#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef id _Nullable (^SnapshotElementReader)(id element, NSUInteger depth, NSUInteger nodes, NSError **error);

/// Native request accounting for one acquisition: requests issued, requests the accessibility
/// server rejected at their depth, continuations (requests that reached the reader beyond the
/// root's accepted one), and the native levels of the last accepted request.
typedef struct {
  NSUInteger requests;
  NSUInteger rejected;
  NSUInteger continuations;
  NSUInteger acceptedLevels;
} SnapshotCaptureRecovery;

/// Materializes one bounded tree; retries bounded native acquisition failures and re-roots withheld
/// children. `nativeLevelsHint` (0 for none) caps only the first request's native levels; the
/// delivered depth, node bounds, and completeness rules are unchanged.
NSDictionary *_Nullable captureSnapshotTree(id element, NSUInteger maxDepth, NSUInteger maxNodes,
                                           NSUInteger nativeLevelsHint, SnapshotElementReader reader,
                                           BOOL *truncated, SnapshotCaptureRecovery *_Nullable recovery,
                                           NSError **error);

NS_ASSUME_NONNULL_END
