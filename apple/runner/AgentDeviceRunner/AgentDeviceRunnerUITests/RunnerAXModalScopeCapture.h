#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <XCTest/XCTest.h>

#import "RunnerAXSnapshotBridge.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_CLOSED_ENUM(NSInteger, RunnerAXModalScopeCaptureStatus) {
  RunnerAXModalScopeCaptureStatusCaptured,
  /// The AX client cannot serve element snapshot requests or cannot identify their elements.
  RunnerAXModalScopeCaptureStatusUnsupported,
  RunnerAXModalScopeCaptureStatusClientUnavailable,
  RunnerAXModalScopeCaptureStatusTargetUnresolved,
  RunnerAXModalScopeCaptureStatusRequestFailed,
  RunnerAXModalScopeCaptureStatusDeadlineExceeded,
};

/// One node of a modal-scope tree. `element` is the node's AX identity,
/// `pid:elementOrHash.elementID`. One element can appear under two parents in one tree, so a node
/// is the pair (`element`, `parentElement`).
@interface RunnerAXModalScopeNode : NSObject
@property(nonatomic, copy, readonly) NSString *element;
@property(nonatomic, copy, readonly, nullable) NSString *parentElement;
/// The parent's position in the tree's `nodes`, or -1 for the root.
@property(nonatomic, assign, readonly) NSInteger parentIndex;
@property(nonatomic, assign, readonly) NSInteger elementType;
@property(nonatomic, copy, readonly) NSString *identifier;
@property(nonatomic, copy, readonly) NSString *label;
@property(nonatomic, assign, readonly) CGRect frame;
@property(nonatomic, copy, readonly, nullable) NSString *viewClass;
@property(nonatomic, copy, readonly, nullable) NSString *viewControllerClass;
@end

/// One tree read, in preorder: each node's parent comes before it.
@interface RunnerAXModalScopeTree : NSObject
@property(nonatomic, copy, readonly) NSArray<RunnerAXModalScopeNode *> *nodes;
/// The node cap or the depth cap clipped the tree.
@property(nonatomic, assign, readonly) BOOL truncated;
@property(nonatomic, assign, readonly) NSTimeInterval duration;
@end

/// Three reads of one app, in this order: the tree with `snapshotKeyHonorModalViews`, which leaves
/// out what a modal view hides from VoiceOver; the whole tree; and the honor-modal tree again. The
/// trees are set only when `status` is captured.
@interface RunnerAXModalScopeCapture : NSObject
@property(nonatomic, assign, readonly) RunnerAXModalScopeCaptureStatus status;
/// The AX error text of a failed request, for diagnostics only.
@property(nonatomic, copy, readonly, nullable) NSString *failure;
@property(nonatomic, strong, readonly, nullable) RunnerAXModalScopeTree *plain;
@property(nonatomic, strong, readonly, nullable) RunnerAXModalScopeTree *honorModal;
@property(nonatomic, strong, readonly, nullable) RunnerAXModalScopeTree *confirmingHonorModal;
@end

@interface RunnerAXSnapshotBridge (ModalScope)

/// Reads the modal-scope trees of the application. `includeClassNames` adds the view and view
/// controller class of each node. The capture fails when `deadline` passes before the last read
/// ends.
+ (RunnerAXModalScopeCapture *)modalScopeCaptureForApplication:(XCUIApplication *)application
                                                       maxDepth:(NSInteger)maxDepth
                                                       maxNodes:(NSInteger)maxNodes
                                              includeClassNames:(BOOL)includeClassNames
                                                       deadline:(NSDate *)deadline;

@end

NS_ASSUME_NONNULL_END
