#import "RunnerAXModalScopeCapture.h"

#import <objc/message.h>

#import "RunnerAXSnapshotBridge+Internal.h"

// The request parameter that makes the AX server answer with the tree VoiceOver reads: content a
// modal view hides is left out. A server that does not know it ignores it silently, so a capture
// cannot tell "no modal" from "parameter ignored"; only a known modal can.
static NSString *const RunnerAXHonorModalViewsParameter = @"snapshotKeyHonorModalViews";

// Requesting this attribute makes the server fill `additionalAttributes` with the view class
// (5004) and, on a view controller's view, the view controller class (5042).
static NSString *const RunnerAXViewControllerClassNameAttribute = @"XC_kAXXCAttributeViewControllerClassName";
static const NSInteger RunnerAXViewClassAdditionalAttribute = 5004;
static const NSInteger RunnerAXViewControllerClassAdditionalAttribute = 5042;

typedef unsigned long long (*RunnerAXUnsignedLongLongMsgSend)(id, SEL);

@interface RunnerAXModalScopeNode ()
@property(nonatomic, copy, readwrite) NSString *element;
@property(nonatomic, copy, readwrite, nullable) NSString *parentElement;
@property(nonatomic, assign, readwrite) NSInteger parentIndex;
@property(nonatomic, assign, readwrite) NSInteger elementType;
@property(nonatomic, copy, readwrite) NSString *identifier;
@property(nonatomic, copy, readwrite) NSString *label;
@property(nonatomic, assign, readwrite) CGRect frame;
@property(nonatomic, copy, readwrite, nullable) NSString *viewClass;
@property(nonatomic, copy, readwrite, nullable) NSString *viewControllerClass;
@end

@implementation RunnerAXModalScopeNode
@end

@interface RunnerAXModalScopeTree ()
@property(nonatomic, copy, readwrite) NSArray<RunnerAXModalScopeNode *> *nodes;
@property(nonatomic, assign, readwrite) BOOL truncated;
@property(nonatomic, assign, readwrite) NSTimeInterval duration;
@end

@implementation RunnerAXModalScopeTree
@end

@interface RunnerAXModalScopeCapture ()
@property(nonatomic, assign, readwrite) RunnerAXModalScopeCaptureStatus status;
@property(nonatomic, copy, readwrite, nullable) NSString *failure;
@property(nonatomic, strong, readwrite, nullable) RunnerAXModalScopeTree *plain;
@property(nonatomic, strong, readwrite, nullable) RunnerAXModalScopeTree *honorModal;
@property(nonatomic, strong, readwrite, nullable) RunnerAXModalScopeTree *confirmingHonorModal;
@end

@implementation RunnerAXModalScopeCapture

+ (instancetype)captureWithStatus:(RunnerAXModalScopeCaptureStatus)status failure:(nullable NSString *)failure
{
  RunnerAXModalScopeCapture *capture = [[self alloc] init];
  capture.status = status;
  capture.failure = failure;
  return capture;
}

@end

@implementation RunnerAXSnapshotBridge (ModalScope)

+ (RunnerAXModalScopeCapture *)modalScopeCaptureForApplication:(XCUIApplication *)application
                                                       maxDepth:(NSInteger)maxDepth
                                                       maxNodes:(NSInteger)maxNodes
                                              includeClassNames:(BOOL)includeClassNames
                                                       deadline:(NSDate *)deadline
{
  @try {
    id axClient = [self accessibilityClient];
    if (nil == axClient) {
      return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusClientUnavailable
                                                  failure:nil];
    }
    if (![axClient respondsToSelector:NSSelectorFromString(@"requestSnapshotForElement:attributes:parameters:error:")]) {
      return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusUnsupported
                                                  failure:nil];
    }
    id target = [self accessibilityApplicationForApplication:application axClient:axClient];
    if (nil == target) {
      return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusTargetUnresolved
                                                  failure:nil];
    }
    NSMutableArray *attributes = [[self attributesForKeyPaths:@[ @"elementType", @"identifier", @"label", @"frame", @"children" ]
                                             consumedSuffixes:@[ @"ElementType", @"Identifier", @"Label", @"Frame" ]]
        mutableCopy];
    if (includeClassNames) {
      [attributes addObject:RunnerAXViewControllerClassNameAttribute];
    }

    // The second honor-modal read confirms the first: a modal that comes or goes between the reads
    // changes the honor-modal tree, while the plain tree alone could still look like a superset.
    NSArray<NSNumber *> *readsHonorModalViews = @[ @YES, @NO, @YES ];
    NSMutableArray<RunnerAXModalScopeTree *> *trees = [NSMutableArray array];
    for (NSNumber *honorModalViews in readsHonorModalViews) {
      if (deadline.timeIntervalSinceNow <= 0) {
        return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusDeadlineExceeded
                                                    failure:nil];
      }
      NSDate *start = [NSDate date];
      NSError *error = nil;
      NSMutableDictionary *parameters = [self snapshotParametersForClient:axClient maxDepth:maxDepth maxNodes:maxNodes];
      parameters[RunnerAXHonorModalViewsParameter] = honorModalViews;
      id root = [self rootSnapshotFromClient:axClient
                                      target:target
                                  attributes:attributes
                                  parameters:parameters
                                       error:&error];
      if (nil == root) {
        return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusRequestFailed
                                                    failure:error.localizedDescription];
      }
      RunnerAXModalScopeTree *tree = [self modalScopeTreeFromSnapshot:root
                                                             maxDepth:maxDepth
                                                             maxNodes:maxNodes
                                                    includeClassNames:includeClassNames];
      if (nil == tree) {
        return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusUnsupported
                                                    failure:nil];
      }
      tree.duration = -start.timeIntervalSinceNow;
      [trees addObject:tree];
    }
    if (deadline.timeIntervalSinceNow <= 0) {
      return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusDeadlineExceeded
                                                  failure:nil];
    }
    RunnerAXModalScopeCapture *capture = [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusCaptured
                                                                              failure:nil];
    capture.honorModal = trees[0];
    capture.plain = trees[1];
    capture.confirmingHonorModal = trees[2];
    return capture;
  } @catch (NSException *exception) {
    return [RunnerAXModalScopeCapture captureWithStatus:RunnerAXModalScopeCaptureStatusRequestFailed
                                                failure:exception.reason ?: exception.name];
  }
}

+ (nullable RunnerAXModalScopeTree *)modalScopeTreeFromSnapshot:(id)root
                                                       maxDepth:(NSInteger)maxDepth
                                                       maxNodes:(NSInteger)maxNodes
                                              includeClassNames:(BOOL)includeClassNames
{
  NSMutableArray<RunnerAXModalScopeNode *> *nodes = [NSMutableArray array];
  BOOL truncated = NO;
  if (![self appendModalScopeSnapshot:root
                               parent:nil
                          parentIndex:-1
                                depth:0
                             maxDepth:maxDepth
                             maxNodes:maxNodes
                    includeClassNames:includeClassNames
                                   to:nodes
                            truncated:&truncated]) {
    return nil;
  }
  RunnerAXModalScopeTree *tree = [[RunnerAXModalScopeTree alloc] init];
  tree.nodes = nodes;
  tree.truncated = truncated;
  return tree;
}

// Returns NO when a node's element has no AX identity.
+ (BOOL)appendModalScopeSnapshot:(id)snapshot
                          parent:(nullable RunnerAXModalScopeNode *)parent
                     parentIndex:(NSInteger)parentIndex
                           depth:(NSInteger)depth
                        maxDepth:(NSInteger)maxDepth
                        maxNodes:(NSInteger)maxNodes
               includeClassNames:(BOOL)includeClassNames
                              to:(NSMutableArray<RunnerAXModalScopeNode *> *)nodes
                       truncated:(BOOL *)truncated
{
  if ((NSInteger)nodes.count >= maxNodes) {
    *truncated = YES;
    return YES;
  }
  NSString *element = [self modalScopeIdentityForElement:[self accessibilityElementForSnapshot:snapshot]];
  if (nil == element) {
    return NO;
  }
  RunnerAXModalScopeNode *node = [[RunnerAXModalScopeNode alloc] init];
  node.element = element;
  node.parentElement = parent.element;
  node.parentIndex = parentIndex;
  node.elementType = [[self numberValueForKey:@"elementType" snapshot:snapshot] integerValue];
  node.identifier = [self stringValueForKey:@"identifier" snapshot:snapshot] ?: @"";
  node.label = [self stringValueForKey:@"label" snapshot:snapshot] ?: @"";
  node.frame = [self frameForSnapshot:snapshot];
  if (includeClassNames) {
    id additional = nil;
    @try {
      additional = [snapshot valueForKey:@"additionalAttributes"];
    } @catch (NSException *exception) {
      additional = nil;
    }
    if ([additional isKindOfClass:NSDictionary.class]) {
      id viewClass = additional[@(RunnerAXViewClassAdditionalAttribute)];
      id viewControllerClass = additional[@(RunnerAXViewControllerClassAdditionalAttribute)];
      node.viewClass = [viewClass isKindOfClass:NSString.class] ? viewClass : nil;
      node.viewControllerClass = [viewControllerClass isKindOfClass:NSString.class] ? viewControllerClass : nil;
    }
  }
  NSInteger index = (NSInteger)nodes.count;
  [nodes addObject:node];
  // The request bounds the server's reply only per element (maxChildren, maxArrayCount) and per
  // level (maxDepth), not in total. The total cap is this count of kept nodes. It also covers an
  // element the server clipped at maxChildren, because that element's children alone reach
  // maxNodes. A tree that reaches either cap may be missing nodes.
  if ((NSInteger)nodes.count >= maxNodes || depth >= maxDepth - 1) {
    *truncated = YES;
    return YES;
  }
  for (id child in [self childrenForSnapshot:snapshot]) {
    if (![self appendModalScopeSnapshot:child
                                 parent:node
                            parentIndex:index
                                  depth:depth + 1
                               maxDepth:maxDepth
                               maxNodes:maxNodes
                      includeClassNames:includeClassNames
                                     to:nodes
                              truncated:truncated]) {
      return NO;
    }
  }
  return YES;
}

+ (nullable NSString *)modalScopeIdentityForElement:(nullable id)element
{
  SEL elementOrHash = NSSelectorFromString(@"elementOrHash");
  SEL elementID = NSSelectorFromString(@"elementID");
  if (nil == element || ![element respondsToSelector:elementOrHash] || ![element respondsToSelector:elementID]) {
    return nil;
  }
  NSInteger processIdentifier = [self integerFrom:element selectorName:@"processIdentifier"];
  if (processIdentifier <= 0) {
    return nil;
  }
  RunnerAXUnsignedLongLongMsgSend send = (RunnerAXUnsignedLongLongMsgSend)objc_msgSend;
  return [NSString stringWithFormat:@"%ld:%llu.%llu", (long)processIdentifier, send(element, elementOrHash),
                                    send(element, elementID)];
}

@end
