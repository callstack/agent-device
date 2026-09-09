#import "SnapshotBridgeCapture.h"

static NSString *const attributesKey = @"UIAccessibilitySnapshotKeyAttributes";
static NSString *const childrenKey = @"UIAccessibilitySnapshotKeyChildren";
static NSString *const childCountKey = @"UIAccessibilitySnapshotKeyChildrenCount";
static NSString *const elementKey = @"UIAccessibilitySnapshotKeyElement";
static const NSUInteger maximumRequests = 32;

@interface SnapshotTreeCapture : NSObject
@property(nonatomic, copy) SnapshotElementReader reader;
@property(nonatomic) NSUInteger acceptedDepth;
@property(nonatomic) NSUInteger remainingNodes;
@property(nonatomic) NSUInteger maximumNodes;
@property(nonatomic) NSUInteger requests;
@property(nonatomic) BOOL truncated;
- (nullable NSDictionary *)read:(id)element depth:(NSUInteger)depth error:(NSError **)error;
- (nullable NSDictionary *)materialize:(NSDictionary *)tree depth:(NSUInteger)depth error:(NSError **)error;
@end

@implementation SnapshotTreeCapture
- (nullable NSDictionary *)read:(id)element depth:(NSUInteger)depth error:(NSError **)error
{
  NSUInteger attemptDepth = MIN(depth, self.acceptedDepth);
  for (;;) {
    if (self.requests >= maximumRequests) {
      if (error) *error = [NSError errorWithDomain:@"agent-device.snapshot" code:1
          userInfo:@{NSLocalizedDescriptionKey: @"snapshot continuation request budget exhausted"}];
      return nil;
    }
    self.requests++;
    NSError *failure = nil;
    id tree = self.reader(element, attemptDepth, MIN(self.maximumNodes, self.remainingNodes + 1), &failure);
    if (tree) return tree;
    NSNumber *nativeCode = failure.userInfo[@"accessibility-error"];
    BOOL rejected = ([nativeCode isKindOfClass:NSNumber.class] && nativeCode.integerValue == -25201) ||
        ([failure.domain isEqualToString:@"com.apple.dt.xctest.automation-support.error"] && failure.code == 5);
    if (!rejected || attemptDepth <= 1) {
      if (error) *error = failure;
      return nil;
    }
    attemptDepth = MAX(1, attemptDepth / 2);
    self.acceptedDepth = attemptDepth;
  }
}

- (nullable NSDictionary *)materialize:(NSDictionary *)tree depth:(NSUInteger)depth error:(NSError **)error
{
  if (![tree isKindOfClass:NSDictionary.class] ||
      ![tree[attributesKey] isKindOfClass:NSDictionary.class] ||
      ![tree[childrenKey] isKindOfClass:NSArray.class]) {
    if (error) *error = [NSError errorWithDomain:@"agent-device.snapshot" code:2
        userInfo:@{NSLocalizedDescriptionKey: @"malformed snapshot continuation"}];
    return nil;
  }
  if (self.remainingNodes == 0) {
    self.truncated = YES;
    return nil;
  }
  self.remainingNodes--;
  NSArray *children = tree[childrenKey];
  NSNumber *childCount = tree[childCountKey];
  BOOL withheld = [childCount isKindOfClass:NSNumber.class] && childCount.unsignedIntegerValue > children.count;
  NSMutableDictionary *result = [tree mutableCopy];
  if (depth <= 1 || self.remainingNodes == 0) {
    self.truncated |= children.count > 0 || withheld;
    result[childrenKey] = @[];
    return result;
  }
  if (withheld && children.count < self.remainingNodes) {
    id element = tree[elementKey];
    if (!element) {
      if (error) *error = [NSError errorWithDomain:@"agent-device.snapshot" code:3
          userInfo:@{NSLocalizedDescriptionKey: @"snapshot continuation element unavailable"}];
      return nil;
    }
    NSDictionary *continuation = [self read:element depth:depth error:error];
    if (!continuation) return nil;
    children = continuation[childrenKey];
    if (![children isKindOfClass:NSArray.class] || children.count < MIN(childCount.unsignedIntegerValue, self.remainingNodes)) {
      if (error) *error = [NSError errorWithDomain:@"agent-device.snapshot" code:4
          userInfo:@{NSLocalizedDescriptionKey: @"snapshot continuation children unavailable"}];
      return nil;
    }
  }
  if (withheld && children.count < childCount.unsignedIntegerValue) self.truncated = YES;
  NSMutableArray *materialized = [NSMutableArray array];
  for (NSDictionary *child in children) {
    if (self.remainingNodes == 0) {
      self.truncated = YES;
      break;
    }
    NSDictionary *node = [self materialize:child depth:depth - 1 error:error];
    if (!node) return nil;
    [materialized addObject:node];
  }
  result[childrenKey] = materialized;
  return result;
}
@end

NSDictionary *captureSnapshotTree(id element, NSUInteger maxDepth, NSUInteger maxNodes,
                                  SnapshotElementReader reader, BOOL *truncated, NSError **error)
{
  SnapshotTreeCapture *capture = [SnapshotTreeCapture new];
  capture.reader = reader;
  capture.acceptedDepth = maxDepth;
  capture.remainingNodes = maxNodes;
  capture.maximumNodes = maxNodes;
  NSDictionary *tree = [capture read:element depth:maxDepth error:error];
  NSDictionary *result = tree ? [capture materialize:tree depth:MAX(1, maxDepth) error:error] : nil;
  *truncated = capture.truncated;
  return result;
}
