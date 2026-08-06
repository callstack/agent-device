#import "RunnerAXSnapshotBridge.h"

#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>

static NSString *const RunnerAXSnapshotOkKey = @"ok";
static NSString *const RunnerAXSnapshotErrorKey = @"error";
static NSString *const RunnerAXSnapshotRootKey = @"root";
static NSString *const RunnerAXSnapshotTruncatedKey = @"truncated";

NSString *const RunnerAXSnapshotDeepExtensionKey = @"deepExtension";
NSString *const RunnerAXSnapshotDeepExtensionCallsKey = @"calls";
NSString *const RunnerAXSnapshotDeepExtensionNodesAddedKey = @"nodesAdded";
NSString *const RunnerAXSnapshotDeepExtensionPendingKey = @"pendingFrontiers";
NSString *const RunnerAXSnapshotDeepExtensionMissedKey = @"missedFrontiers";

typedef id (*RunnerAXObjectMsgSend)(id, SEL);
typedef NSInteger (*RunnerAXIntegerMsgSend)(id, SEL);
typedef id (*RunnerAXSnapshotMsgSend)(id, SEL, id, id, id, NSError **);

// A childless serialized node remembered with its depth (interface in the
// header for the unit bundle). Nodes at the deepest observed level of a
// depth-capped capture are the truncation frontier: the AX server withholds
// children uniformly at its per-request cap, so every capped branch ends at
// the same level (observed one BELOW the requested maxDepth — the server
// counts node levels, not edges).
@implementation RunnerAXSnapshotFrontier
@end

@implementation RunnerAXSnapshotBridge

+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes
                                      deepExtensionCallLimit:(NSInteger)deepExtensionCallLimit
                                                    deadline:(nullable NSDate *)deadline
{
  @try {
    id axClient = [self objectFrom:XCUIDevice.sharedDevice selectorName:@"accessibilityInterface"];
    if (nil == axClient) {
      return [self failure:@"XCUIDevice accessibilityInterface is unavailable"];
    }

    id target = [self accessibilityApplicationForApplication:application axClient:axClient];
    if (nil == target) {
      return [self failure:@"Could not match active AX application for XCTest application"];
    }

    NSArray *attributes = [self snapshotAttributes];
    NSError *error = nil;
    id root = [self requestSnapshotFromClient:axClient
                                      target:target
                                  attributes:attributes
                                    maxDepth:maxDepth
                                    maxNodes:maxNodes
                                       error:&error];
    if (nil == root) {
      return [self failure:error.localizedDescription ?: @"AX snapshot request returned nil"];
    }

    BOOL truncated = NO;
    NSInteger nodeCount = 0;
    // nil disables candidate collection entirely — exact --depth captures pay
    // zero extension bookkeeping.
    NSMutableArray<RunnerAXSnapshotFrontier *> *candidates =
        deepExtensionCallLimit > 0 ? [NSMutableArray array] : nil;
    NSMutableDictionary *rootNode = [self dictionaryForSnapshot:root
                                                          depth:0
                                                       maxDepth:maxDepth
                                                       maxNodes:maxNodes
                                                      nodeCount:&nodeCount
                                                      truncated:&truncated
                                                      frontiers:candidates];
    if (nil == rootNode) {
      return [self failure:@"AX snapshot root could not be serialized"];
    }

    NSMutableArray<RunnerAXSnapshotFrontier *> *frontiers =
        [self cappedFrontiersFromCandidates:candidates ?: @[] maxDepth:maxDepth];
    NSDictionary *deepExtension = [self extendSnapshotFrontiers:frontiers
                                                       axClient:axClient
                                                     attributes:attributes
                                                       maxDepth:maxDepth
                                                       maxNodes:maxNodes
                                                      nodeCount:&nodeCount
                                                      truncated:&truncated
                                                   callsAllowed:deepExtensionCallLimit
                                                       deadline:deadline];

    NSMutableDictionary *response = [NSMutableDictionary dictionaryWithDictionary:@{
      RunnerAXSnapshotOkKey: @YES,
      RunnerAXSnapshotRootKey: rootNode,
      RunnerAXSnapshotTruncatedKey: @(truncated),
    }];
    if (nil != deepExtension) {
      response[RunnerAXSnapshotDeepExtensionKey] = deepExtension;
    }
    return response.copy;
  } @catch (NSException *exception) {
    return [self failure:exception.reason ?: exception.name ?: @"AX snapshot bridge exception"];
  }
}

/// Chains element-rooted snapshot requests from depth-capped frontier nodes.
/// The AX server's depth limit is per-request (kAXErrorIllegalArgument above a
/// tree-size-dependent value), so re-rooting the SAME request at a frontier
/// node's live accessibility element reaches content the app-rooted request
/// could not, without ever passing a larger depth parameter. Bounded by call
/// count, the shared node budget, and the capture-plan deadline.
+ (nullable NSDictionary *)extendSnapshotFrontiers:(NSMutableArray<RunnerAXSnapshotFrontier *> *)frontiers
                                          axClient:(id)axClient
                                        attributes:(NSArray *)attributes
                                          maxDepth:(NSInteger)maxDepth
                                          maxNodes:(NSInteger)maxNodes
                                         nodeCount:(NSInteger *)nodeCount
                                         truncated:(BOOL *)truncated
                                      callsAllowed:(NSInteger)callsAllowed
                                          deadline:(nullable NSDate *)deadline
{
  if (callsAllowed <= 0 || frontiers.count == 0) {
    return nil;
  }
  NSInteger callsUsed = 0;
  NSInteger nodesAdded = 0;
  // A frontier whose live element vanished (list churn between serialization
  // and extension) or whose re-rooted request failed leaves its subtree
  // unresolved — it must count as missed, never as drained, or an all-miss
  // extension would present a capped capture as complete.
  NSInteger missedFrontiers = 0;
  while (frontiers.count > 0) {
    if (callsUsed >= callsAllowed || *nodeCount >= maxNodes
        || (nil != deadline && deadline.timeIntervalSinceNow <= 0)) {
      *truncated = YES;
      break;
    }
    RunnerAXSnapshotFrontier *frontier = frontiers.firstObject;
    [frontiers removeObjectAtIndex:0];
    id element = [self accessibilityElementForSnapshot:frontier.snapshot];
    if (nil == element) {
      missedFrontiers += 1;
      NSLog(@"AGENT_DEVICE_RUNNER_PRIVATE_AX_DEEP_EXTENSION_MISS=element unavailable");
      continue;
    }
    callsUsed += 1;
    NSError *error = nil;
    id subRoot = [self requestSnapshotFromClient:axClient
                                          target:element
                                      attributes:attributes
                                        maxDepth:maxDepth
                                        maxNodes:maxNodes - *nodeCount
                                           error:&error];
    if (nil == subRoot) {
      missedFrontiers += 1;
      NSLog(@"AGENT_DEVICE_RUNNER_PRIVATE_AX_DEEP_EXTENSION_MISS=%@",
            error.localizedDescription ?: @"nil subtree");
      continue;
    }
    // The re-rooted snapshot's root IS the frontier element captured again;
    // splice only its children so the frontier node is not duplicated.
    NSInteger before = *nodeCount;
    NSMutableArray<RunnerAXSnapshotFrontier *> *subCandidates = [NSMutableArray array];
    NSMutableArray *children = [NSMutableArray array];
    for (id child in [self childrenForSnapshot:subRoot]) {
      NSMutableDictionary *childNode = [self dictionaryForSnapshot:child
                                                             depth:1
                                                          maxDepth:maxDepth
                                                          maxNodes:maxNodes
                                                         nodeCount:nodeCount
                                                         truncated:truncated
                                                         frontiers:subCandidates];
      if (nil != childNode) {
        [children addObject:childNode];
      }
      if (*nodeCount >= maxNodes) {
        *truncated = YES;
        break;
      }
    }
    frontier.node[@"children"] = children;
    nodesAdded += *nodeCount - before;
    [frontiers addObjectsFromArray:[self cappedFrontiersFromCandidates:subCandidates
                                                              maxDepth:maxDepth]];
  }
  NSLog(@"AGENT_DEVICE_RUNNER_PRIVATE_AX_DEEP_EXTENSION calls=%ld nodes=%ld pending=%ld missed=%ld",
        (long)callsUsed, (long)nodesAdded, (long)frontiers.count, (long)missedFrontiers);
  return @{
    RunnerAXSnapshotDeepExtensionCallsKey: @(callsUsed),
    RunnerAXSnapshotDeepExtensionNodesAddedKey: @(nodesAdded),
    RunnerAXSnapshotDeepExtensionPendingKey: @(frontiers.count),
    RunnerAXSnapshotDeepExtensionMissedKey: @(missedFrontiers),
  };
}

/// Keeps only candidates at the deepest observed level, and only when that
/// level sits at the request's cap (the server emits maxDepth node LEVELS, so
/// the deepest possible level is maxDepth - 1). A tree that ended naturally
/// above the cap yields no frontiers and costs nothing.
+ (NSMutableArray<RunnerAXSnapshotFrontier *> *)cappedFrontiersFromCandidates:
    (NSArray<RunnerAXSnapshotFrontier *> *)candidates
                                                                      maxDepth:(NSInteger)maxDepth
{
  NSMutableArray<RunnerAXSnapshotFrontier *> *frontiers = [NSMutableArray array];
  NSInteger deepest = -1;
  for (RunnerAXSnapshotFrontier *candidate in candidates) {
    deepest = MAX(deepest, candidate.depth);
  }
  if (deepest < maxDepth - 1) {
    return frontiers;
  }
  for (RunnerAXSnapshotFrontier *candidate in candidates) {
    if (candidate.depth == deepest) {
      [frontiers addObject:candidate];
    }
  }
  return frontiers;
}

+ (nullable id)requestSnapshotFromClient:(id)axClient
                                  target:(id)target
                              attributes:(NSArray *)attributes
                                maxDepth:(NSInteger)maxDepth
                                maxNodes:(NSInteger)maxNodes
                                   error:(NSError **)error
{
  SEL requestSelector = NSSelectorFromString(@"requestSnapshotForElement:attributes:parameters:error:");
  if (![axClient respondsToSelector:requestSelector]) {
    if (NULL != error) {
      *error = [NSError errorWithDomain:@"agent-device.runner"
                                   code:1
                               userInfo:@{
                                 NSLocalizedDescriptionKey:
                                     @"AX client does not support requestSnapshotForElement"
                               }];
    }
    return nil;
  }
  NSMutableDictionary *parameters = [NSMutableDictionary dictionary];
  id defaults = [self objectFrom:axClient selectorName:@"defaultParameters"];
  if ([defaults isKindOfClass:NSDictionary.class]) {
    [parameters addEntriesFromDictionary:(NSDictionary *)defaults];
  }
  parameters[@"maxDepth"] = @(MAX(0, maxDepth));
  parameters[@"maxChildren"] = @(MAX(1, maxNodes));
  parameters[@"maxArrayCount"] = @(MAX(1, maxNodes));
  parameters[@"traverseFromParentsToChildren"] = @YES;

  RunnerAXSnapshotMsgSend send = (RunnerAXSnapshotMsgSend)objc_msgSend;
  id result = send(axClient, requestSelector, target, attributes, parameters.copy, error);
  if (nil == result) {
    return nil;
  }
  id root = nil;
  @try {
    root = [result valueForKey:@"_rootElementSnapshot"];
  } @catch (NSException *exception) {
    root = nil;
  }
  return root ?: result;
}

+ (NSArray *)snapshotAttributes
{
  NSArray<NSString *> *keyPaths = @[
    @"elementType",
    @"identifier",
    @"label",
    @"value",
    @"frame",
    @"enabled",
    @"selected",
    @"hasFocus",
    @"children",
  ];
  // The AX server expects real accessibility attribute identifiers, not snapshot keypath
  // strings; passing raw keypaths silently drops attributes it does not recognize (frame
  // came back zeroed). XCElementSnapshot owns the keypath -> AX attribute mapping.
  NSArray *attributes = keyPaths;
  Class snapshotClass = NSClassFromString(@"XCElementSnapshot");
  SEL mapSelector = NSSelectorFromString(@"axAttributesForElementSnapshotKeyPaths:isMacOS:");
  if ([snapshotClass respondsToSelector:mapSelector]) {
    typedef id (*RunnerAXMapMsgSend)(id, SEL, id, BOOL);
    RunnerAXMapMsgSend mapSend = (RunnerAXMapMsgSend)objc_msgSend;
    id mapped = mapSend(snapshotClass, mapSelector, keyPaths, NO);
    if ([mapped isKindOfClass:NSSet.class]) {
      mapped = [(NSSet *)mapped allObjects];
    }
    if ([mapped isKindOfClass:NSArray.class] && [(NSArray *)mapped count] > 0) {
      // The mapper expands keypaths with extra attributes (automation type, window display
      // id, base type) that are disproportionately expensive for the AX server to compute
      // on large React Native trees. Keep only the attributes we actually consume.
      NSArray *needed = @[ @"ElementType", @"Identifier", @"Label", @"Value", @"Frame",
                           @"Enabled", @"Selected", @"Focus" ];
      NSMutableArray *filtered = [NSMutableArray array];
      for (id attribute in (NSArray *)mapped) {
        NSString *name = [attribute description];
        for (NSString *suffix in needed) {
          if ([name hasSuffix:suffix]) {
            [filtered addObject:attribute];
            break;
          }
        }
      }
      attributes = filtered.count > 0 ? filtered : mapped;
    }
  }
  return attributes;
}

+ (nullable id)accessibilityElementForSnapshot:(id)snapshot
{
  id element = nil;
  @try {
    element = [snapshot valueForKey:@"accessibilityElement"];
  } @catch (NSException *exception) {
    element = nil;
  }
  return element;
}

+ (NSDictionary<NSString *, id> *)failure:(NSString *)message
{
  return @{
    RunnerAXSnapshotOkKey: @NO,
    RunnerAXSnapshotErrorKey: message,
  };
}

+ (id)objectFrom:(id)target selectorName:(NSString *)selectorName
{
  SEL selector = NSSelectorFromString(selectorName);
  if (![target respondsToSelector:selector]) {
    return nil;
  }
  RunnerAXObjectMsgSend send = (RunnerAXObjectMsgSend)objc_msgSend;
  return send(target, selector);
}

+ (NSInteger)integerFrom:(id)target selectorName:(NSString *)selectorName
{
  SEL selector = NSSelectorFromString(selectorName);
  if (![target respondsToSelector:selector]) {
    return 0;
  }
  // processID/processIdentifier return pid_t (int32); reading them through an
  // NSInteger-returning cast is not upper-32-bit safe on arm64. Use the method
  // signature to pick the correctly sized call.
  NSMethodSignature *signature = [target methodSignatureForSelector:selector];
  const char *returnType = signature.methodReturnType;
  if (returnType != NULL && strcmp(returnType, @encode(int)) == 0) {
    typedef int (*RunnerAXIntMsgSend)(id, SEL);
    RunnerAXIntMsgSend send = (RunnerAXIntMsgSend)objc_msgSend;
    return (NSInteger)send(target, selector);
  }
  RunnerAXIntegerMsgSend send = (RunnerAXIntegerMsgSend)objc_msgSend;
  return send(target, selector);
}

+ (NSInteger)processIdentifierForApplication:(XCUIApplication *)application
{
  return [self integerFrom:application selectorName:@"processID"];
}

+ (id)accessibilityApplicationForApplication:(XCUIApplication *)application axClient:(id)axClient
{
  NSInteger targetProcessID = [self integerFrom:application selectorName:@"processID"];
  id activeApplications = [self objectFrom:axClient selectorName:@"activeApplications"];
  if (![activeApplications isKindOfClass:NSArray.class]) {
    return nil;
  }

  for (id candidate in (NSArray *)activeApplications) {
    NSInteger candidateProcessID = [self integerFrom:candidate selectorName:@"processIdentifier"];
    if (targetProcessID > 0 && candidateProcessID == targetProcessID) {
      return candidate;
    }
  }
  return nil;
}

+ (nullable NSMutableDictionary *)dictionaryForSnapshot:(id)snapshot
                                                  depth:(NSInteger)depth
                                               maxDepth:(NSInteger)maxDepth
                                               maxNodes:(NSInteger)maxNodes
                                              nodeCount:(NSInteger *)nodeCount
                                              truncated:(BOOL *)truncated
                                              frontiers:(NSMutableArray<RunnerAXSnapshotFrontier *> *)frontiers
{
  if (nil == snapshot || *nodeCount >= maxNodes) {
    *truncated = YES;
    return nil;
  }

  *nodeCount += 1;
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  result[@"type"] = [self numberValueForKey:@"elementType" snapshot:snapshot] ?: @0;
  result[@"identifier"] = [self stringValueForKey:@"identifier" snapshot:snapshot] ?: @"";
  result[@"label"] = [self stringValueForKey:@"label" snapshot:snapshot] ?: @"";
  result[@"value"] = [self stringValueForKey:@"value" snapshot:snapshot] ?: @"";
  result[@"frame"] = [self frameValueForSnapshot:snapshot];
  result[@"enabled"] = [self boolNumberForKey:@"enabled" snapshot:snapshot defaultValue:YES];
  result[@"selected"] = [self boolNumberForKey:@"selected" snapshot:snapshot defaultValue:NO];
  result[@"focused"] = [self boolNumberForKey:@"hasFocus" snapshot:snapshot defaultValue:NO];

  NSMutableArray *children = [NSMutableArray array];
  if (depth < maxDepth) {
    for (id child in [self childrenForSnapshot:snapshot]) {
      NSMutableDictionary *childNode = [self dictionaryForSnapshot:child
                                                             depth:depth + 1
                                                          maxDepth:maxDepth
                                                          maxNodes:maxNodes
                                                         nodeCount:nodeCount
                                                         truncated:truncated
                                                         frontiers:frontiers];
      if (nil != childNode) {
        [children addObject:childNode];
      }
      if (*nodeCount >= maxNodes) {
        *truncated = YES;
        break;
      }
    }
  }
  if (children.count == 0 && nil != frontiers && depth >= maxDepth - 1) {
    // Childless node at the cap boundary: either a real leaf or a branch whose
    // children the AX server withheld. The two are indistinguishable here, so
    // boundary childless nodes become candidates; the caller keeps only the
    // deepest observed level, where every capped branch necessarily ends.
    // Shallower childless nodes are provably real leaves and are never
    // collected.
    RunnerAXSnapshotFrontier *frontier = [[RunnerAXSnapshotFrontier alloc] init];
    frontier.snapshot = snapshot;
    frontier.node = result;
    frontier.depth = depth;
    [frontiers addObject:frontier];
  }
  result[@"children"] = children;
  return result;
}

+ (NSArray *)childrenForSnapshot:(id)snapshot
{
  id children = nil;
  @try {
    children = [snapshot valueForKey:@"children"];
  } @catch (NSException *exception) {
    children = nil;
  }
  return [children isKindOfClass:NSArray.class] ? children : @[];
}

+ (nullable NSNumber *)numberValueForKey:(NSString *)key snapshot:(id)snapshot
{
  id value = nil;
  @try {
    value = [snapshot valueForKey:key];
  } @catch (NSException *exception) {
    return nil;
  }
  return [value isKindOfClass:NSNumber.class] ? value : nil;
}

+ (nullable NSString *)stringValueForKey:(NSString *)key snapshot:(id)snapshot
{
  id value = nil;
  @try {
    value = [snapshot valueForKey:key];
  } @catch (NSException *exception) {
    return nil;
  }
  if (nil == value || value == NSNull.null) {
    return nil;
  }
  if ([value isKindOfClass:NSString.class]) {
    return [(NSString *)value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  }
  return [[value description] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

+ (NSNumber *)boolNumberForKey:(NSString *)key snapshot:(id)snapshot defaultValue:(BOOL)defaultValue
{
  NSNumber *value = [self numberValueForKey:key snapshot:snapshot];
  return nil == value ? @(defaultValue) : @([value boolValue]);
}

+ (NSDictionary *)frameValueForSnapshot:(id)snapshot
{
  CGRect frame = CGRectZero;
  @try {
    id value = [snapshot valueForKey:@"frame"];
    if ([value isKindOfClass:NSValue.class]
        && strcmp([(NSValue *)value objCType], @encode(CGRect)) == 0) {
      [(NSValue *)value getValue:&frame];
    }
  } @catch (NSException *exception) {
    frame = CGRectZero;
  }
  if (CGRectIsNull(frame) || CGRectIsInfinite(frame)) {
    frame = CGRectZero;
  }
  return @{
    @"x": @(CGRectGetMinX(frame)),
    @"y": @(CGRectGetMinY(frame)),
    @"width": @(CGRectGetWidth(frame)),
    @"height": @(CGRectGetHeight(frame)),
  };
}

@end
