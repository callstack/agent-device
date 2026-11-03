#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Native levels one request reads at most; deeper levels arrive through continuations.
extern const NSUInteger kMaximumRequestLevels;
/// Requests one acquisition may issue before it fails as continuation-budget-exhausted.
extern const NSUInteger kMaximumRequestsPerCapture;

/// The domain of every error the tree reader reports.
extern NSErrorDomain const SnapshotCaptureErrorDomain;

/// Why the reader stopped. The runtime maps each one to its wire refusal code.
typedef NS_ERROR_ENUM(SnapshotCaptureErrorDomain, SnapshotCaptureError) {
  /// The acquisition used every request it may issue.
  SnapshotCaptureErrorBudgetExhausted = 1,
  /// A native read returned a node that is not a snapshot dictionary.
  SnapshotCaptureErrorMalformedContinuation = 2,
  /// A node withheld children but carried no element to continue from.
  SnapshotCaptureErrorContinuationElementUnavailable = 3,
  /// A continuation re-read returned fewer children than the first read reported: the tree changed
  /// between the two reads, as a scrolling list does when it recycles its cells.
  SnapshotCaptureErrorTreeChanged = 4,
  /// The foreground process changed while a continuation was read.
  SnapshotCaptureErrorForegroundOwnerChanged = 5,
  /// A node below the first level reported no child count, so its children cannot be bounded.
  SnapshotCaptureErrorBoundaryChildCountUnavailable = 6,
};

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
