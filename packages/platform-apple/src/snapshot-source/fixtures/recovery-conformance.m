// Host-bridge adapter for contracts/fixtures/ios-ax-recovery-conformance.json: replays one
// recovery case through captureSnapshotTree with a scripted native reader and compares the
// producer-neutral outcome against the fixture's `host-bridge` expectation.
#import "SnapshotBridgeCapture.h"

#import <Foundation/Foundation.h>

static NSString *const kAttributes = @"UIAccessibilitySnapshotKeyAttributes";
static NSString *const kChildren = @"UIAccessibilitySnapshotKeyChildren";
static NSString *const kChildCount = @"UIAccessibilitySnapshotKeyChildrenCount";
static NSString *const kElement = @"UIAccessibilitySnapshotKeyElement";
static NSString *const kIdentity = @"identity";

@interface FixtureNode : NSObject
@property(nonatomic) NSUInteger level;
@property(nonatomic, copy) NSString *identity;
@property(nonatomic, weak) FixtureNode *parent;
@property(nonatomic, strong) NSMutableArray<FixtureNode *> *children;
@end
@implementation FixtureNode
@end

static FixtureNode *makeNode(NSUInteger level, NSString *identity)
{
  FixtureNode *node = [FixtureNode new];
  node.level = level;
  node.identity = identity;
  node.children = [NSMutableArray array];
  return node;
}

static void buildChain(FixtureNode *parent, NSUInteger count, NSString *branch)
{
  FixtureNode *current = parent;
  for (NSUInteger index = 0; index < count; index++) {
    NSUInteger level = current.level + 1;
    FixtureNode *next = makeNode(level, branch ? [NSString stringWithFormat:@"%lu.%@", (unsigned long)level, branch]
                                              : @(level).stringValue);
    next.parent = current;
    [current.children addObject:next];
    current = next;
  }
}

static FixtureNode *buildTree(NSDictionary *tree, NSMutableDictionary<NSString *, FixtureNode *> *index)
{
  FixtureNode *root = makeNode(0, @"0");
  buildChain(root, [tree[@"chain"] unsignedIntegerValue] - 1, nil);
  NSDictionary *fan = tree[@"fan"];
  if ([fan isKindOfClass:NSDictionary.class]) {
    FixtureNode *at = root;
    while (at.children.count) at = at.children.firstObject;
    for (NSUInteger branch = 0; branch < [fan[@"count"] unsignedIntegerValue]; branch++) {
      NSString *name = @(branch).stringValue;
      FixtureNode *head = makeNode(at.level + 1, [NSString stringWithFormat:@"%lu.%@", (unsigned long)at.level + 1, name]);
      head.parent = at;
      [at.children addObject:head];
      buildChain(head, [fan[@"chain"] unsignedIntegerValue], name);
    }
  }
  void (^visit)(FixtureNode *) = ^(FixtureNode *node) {
    index[node.identity] = node;
  };
  NSMutableArray<FixtureNode *> *queue = [NSMutableArray arrayWithObject:root];
  while (queue.count) {
    FixtureNode *node = queue.firstObject;
    [queue removeObjectAtIndex:0];
    visit(node);
    [queue addObjectsFromArray:node.children];
  }
  return root;
}

static NSDictionary *fragment(FixtureNode *node, NSUInteger remainingLevels, BOOL unknownAtBoundary, BOOL vanishAtBoundary)
{
  BOOL boundary = remainingLevels == 1;
  NSMutableArray *children = [NSMutableArray array];
  if (!boundary) {
    for (FixtureNode *child in node.children) {
      [children addObject:fragment(child, remainingLevels - 1, unknownAtBoundary, vanishAtBoundary)];
    }
  }
  NSMutableDictionary *result = [@{kAttributes: @{kIdentity: node.identity}, kChildren: children} mutableCopy];
  if (!(boundary && unknownAtBoundary)) result[kChildCount] = @(node.children.count);
  if (!(boundary && vanishAtBoundary)) result[kElement] = node.identity;
  return result;
}

static NSUInteger identityLevel(NSString *identity)
{
  return (NSUInteger)[[identity componentsSeparatedByString:@"."].firstObject integerValue];
}

static NSString *identityBranch(NSString *identity)
{
  NSArray *parts = [identity componentsSeparatedByString:@"."];
  return parts.count > 1 ? parts[1] : @"";
}

/// Bounded by the bridge's node limit: a producer that emits a cyclic or shared subtree must read
/// as an oversized signature, not as a hang.
static const NSUInteger maximumSignatureNodes = 10000;

static void collectPreorder(NSDictionary *node, NSString *parent, NSMutableArray<NSArray<NSString *> *> *out)
{
  if (out.count >= maximumSignatureNodes) return;
  NSString *identity = node[kAttributes][kIdentity];
  [out addObject:@[identity, parent ?: @""]];
  for (NSDictionary *child in node[kChildren]) collectPreorder(child, identity, out);
}

/// The canonical signature described by the fixture's `nativeModel.signature`: preorder identities,
/// `<parent` when a node hangs off a non-canonical parent, and `first-last` for a run of consecutive
/// levels on one branch.
static NSString *treeSignature(NSDictionary *tree, NSDictionary<NSString *, FixtureNode *> *index, NSUInteger *count)
{
  NSMutableArray<NSArray<NSString *> *> *preorder = [NSMutableArray array];
  collectPreorder(tree, nil, preorder);
  *count = preorder.count;
  NSMutableArray<NSString *> *tokens = [NSMutableArray array];
  __block NSString *runStart = nil;
  __block NSString *runLast = nil;
  void (^flush)(void) = ^{
    if (!runStart) return;
    [tokens addObject:[runStart isEqual:runLast] ? runStart : [NSString stringWithFormat:@"%@-%@", runStart, runLast]];
  };
  for (NSArray<NSString *> *entry in preorder) {
    NSString *identity = entry[0];
    NSString *observedParent = entry[1];
    NSString *canonicalParent = index[identity].parent.identity ?: @"";
    if (![observedParent isEqual:canonicalParent]) {
      flush();
      runStart = runLast = nil;
      [tokens addObject:[NSString stringWithFormat:@"%@<%@", identity, observedParent]];
      continue;
    }
    BOOL extends = runLast && [observedParent isEqual:runLast] &&
        [identityBranch(identity) isEqual:identityBranch(runLast)] && identityLevel(identity) == identityLevel(runLast) + 1;
    if (extends) {
      runLast = identity;
      continue;
    }
    flush();
    runStart = runLast = identity;
  }
  flush();
  return [tokens componentsJoinedByString:@","];
}

static NSUInteger deepestLevel(NSDictionary *node)
{
  NSUInteger deepest = identityLevel(node[kAttributes][kIdentity]);
  for (NSDictionary *child in node[kChildren]) deepest = MAX(deepest, deepestLevel(child));
  return deepest;
}

static NSString *failureName(NSError *error)
{
  if ([error.domain isEqualToString:@"agent-device.snapshot"]) {
    switch (error.code) {
      case 1: return @"request-budget-exhausted";
      case 3: return @"continuation-element-missing";
      case 5: return @"owner-changed";
      case 6: return @"boundary-evidence-missing";
      default: return [NSString stringWithFormat:@"capture-%ld", (long)error.code];
    }
  }
  return @"rejected";
}

static int fail(NSString *caseName, NSString *message)
{
  fprintf(stderr, "%s: %s\n", caseName.UTF8String, message.UTF8String);
  return 1;
}

int main(int argc, const char *argv[])
{
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "usage: recovery-conformance <fixture.json> <case-name>\n");
      return 2;
    }
    NSData *data = [NSData dataWithContentsOfFile:@(argv[1])];
    NSDictionary *fixture = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
    NSString *caseName = @(argv[2]);
    NSDictionary *recoveryCase = nil;
    for (NSDictionary *candidate in fixture[@"recoveryCases"]) {
      if ([candidate[@"name"] isEqual:caseName]) recoveryCase = candidate;
    }
    if (!recoveryCase) return fail(caseName, @"unknown recovery case");
    NSDictionary *expected = recoveryCase[@"expected"][@"host-bridge"];
    if ([expected[@"outcome"] isEqual:@"not-applicable"]) {
      fprintf(stdout, "%s: not applicable to host-bridge (%s)\n", caseName.UTF8String, [expected[@"reason"] UTF8String]);
      return 0;
    }

    NSDictionary *request = recoveryCase[@"request"];
    NSDictionary *native = recoveryCase[@"native"];
    NSMutableDictionary<NSString *, FixtureNode *> *index = [NSMutableDictionary dictionary];
    FixtureNode *root = buildTree(native[@"tree"], index);
    NSNumber *rejectAbove = [native[@"rejectLevelsAbove"] isKindOfClass:NSNumber.class] ? native[@"rejectLevelsAbove"] : nil;
    NSNumber *ownerChangesAfter = [native[@"ownerChangesAfterRequests"] isKindOfClass:NSNumber.class] ? native[@"ownerChangesAfterRequests"] : nil;
    BOOL unknownAtBoundary = [native[@"frontierEvidence"] isEqual:@"unknown"];
    BOOL vanishAtBoundary = [native[@"vanishAtFrontier"] boolValue];
    NSUInteger hint = [request[@"hint"][@"host-bridge"] unsignedIntegerValue];
    __block NSUInteger requests = 0;
    __block NSUInteger rejected = 0;

    BOOL truncated = NO;
    SnapshotCaptureRecovery recovery = {0, 0, 0, 0};
    NSError *error = nil;
    NSDictionary *result = captureSnapshotTree(root.identity, [request[@"traversalDepth"] unsignedIntegerValue],
        [request[@"nodeBudget"] unsignedIntegerValue], hint,
        ^id(id element, NSUInteger levels, NSUInteger nodes, NSError **readError) {
          requests++;
          if (ownerChangesAfter && requests > ownerChangesAfter.unsignedIntegerValue) {
            *readError = [NSError errorWithDomain:@"agent-device.snapshot" code:5 userInfo:nil];
            return nil;
          }
          if (rejectAbove && levels > rejectAbove.unsignedIntegerValue) {
            rejected++;
            *readError = [NSError errorWithDomain:@"AX" code:-25201 userInfo:@{@"accessibility-error": @(-25201)}];
            return nil;
          }
          FixtureNode *node = index[element];
          if (!node) {
            *readError = [NSError errorWithDomain:@"fixture" code:0 userInfo:nil];
            return nil;
          }
          return fragment(node, levels, unknownAtBoundary, vanishAtBoundary);
        }, &truncated, &recovery, &error);

    // The guest's accounting is what the host learns from and reports, so it must agree with what
    // the reader observed: every request, every rejection, and the continuations beyond the root.
    if (recovery.requests != requests || recovery.rejected != rejected ||
        recovery.continuations != requests - rejected - (requests > rejected ? 1 : 0)) {
      return fail(caseName, @"recovery accounting must count every native request, rejection, and continuation");
    }
    NSMutableDictionary *actual = [NSMutableDictionary dictionary];
    actual[@"requests"] = @(recovery.requests);
    actual[@"rejected"] = @(recovery.rejected);
    actual[@"continuations"] = @(recovery.continuations);
    if (result) {
      NSUInteger nodes = 0;
      actual[@"outcome"] = truncated ? @"incomplete" : @"complete";
      actual[@"deepestLevel"] = @(deepestLevel(result));
      actual[@"tree"] = treeSignature(result, index, &nodes);
      actual[@"nodes"] = @(nodes);
    } else {
      actual[@"outcome"] = @"failed";
      actual[@"failure"] = failureName(error);
    }
    int status = 0;
    for (NSString *key in expected) {
      if ([key isEqual:@"reason"]) continue;
      if (![expected[key] isEqual:actual[key]]) {
        status = fail(caseName, [NSString stringWithFormat:@"%@ expected %@ but observed %@", key, expected[key], actual[key] ?: @"(absent)"]);
      }
    }
    return status;
  }
}
