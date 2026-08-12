#import "RunnerAXSnapshotBridge.h"

#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#import <stdatomic.h>

static NSString *const RunnerAXSnapshotOkKey = @"ok";
static NSString *const RunnerAXSnapshotErrorKey = @"error";
static NSString *const RunnerAXSnapshotRootKey = @"root";
static NSString *const RunnerAXSnapshotTruncatedKey = @"truncated";

NSString *const RunnerAXSnapshotDeepExtensionKey = @"deepExtension";
NSString *const RunnerAXSnapshotDeepExtensionCallsKey = @"calls";
NSString *const RunnerAXSnapshotDeepExtensionNodesAddedKey = @"nodesAdded";
NSString *const RunnerAXSnapshotDeepExtensionPendingKey = @"pendingFrontiers";
NSString *const RunnerAXSnapshotDeepExtensionMissedKey = @"missedFrontiers";

NSString *const RunnerAXSnapshotCustomActionsKey = @"customActions";
NSString *const RunnerAXSnapshotCustomActionsReadKey = @"read";
NSString *const RunnerAXSnapshotCustomActionsCandidatesKey = @"candidates";
NSString *const RunnerAXSnapshotCustomActionsTruncatedKey = @"truncated";
NSString *const RunnerAXSnapshotCustomActionsBlockedKey = @"blocked";

/// The AX server's name for UIAccessibilityCustomActions (React Native's
/// `accessibilityActions` prop lands here too).
static NSString *const RunnerAXCustomActionsAttribute = @"XC_kAXXCAttributeCustomActions";

/// A single read costs ~100ms against a responsive app. This bound exists for
/// the unresponsive case: without it one wedged element would swallow the whole
/// capture's budget and starve every remaining candidate, turning a bounded
/// enrichment into a capture-length stall.
static const NSTimeInterval RunnerAXCustomActionReadTimeout = 1.0;

/// The AX call is a synchronous XPC round trip that cannot be cancelled once
/// issued, so the deadline above only frees the CALLER — the call itself keeps
/// running. Containment therefore has two parts, and both are needed:
///
///  1. every read runs on this one serial queue, so a wedged call can never be
///     joined by a second concurrent user of the shared XCAXClient;
///  2. a single-flight guard (below) refuses to dispatch while an abandoned
///     read is still outstanding, so repeated captures cannot pile up work
///     behind it.
///
/// Reads resume by themselves once the hung call returns (or the runner
/// restarts); nothing has to be reset by hand.
static dispatch_queue_t RunnerAXCustomActionReadQueue(void)
{
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.callstack.agentdevice.runner.ax-custom-actions",
                                  DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

/// Reads dispatched but not yet returned. Non-zero after a read blew its
/// deadline, which is exactly the condition the single-flight guard refuses on.
static atomic_int RunnerAXCustomActionReadsInFlight = 0;

/// Total dispatches. The invariant the containment fix exists to protect is
/// "a blocked capture adds no work", which is only observable as this counter
/// staying put, so it is recorded rather than inferred.
static atomic_long RunnerAXCustomActionReadDispatches = 0;

/// Total single-flight admission refusals.
static atomic_long RunnerAXCustomActionReadBlocked = 0;

/// Output caps. The element budget bounds how many elements we read; these
/// bound what any ONE element can put in the response, so a pathological app
/// cannot spend the whole snapshot on one node's action list.
static const NSUInteger RunnerAXCustomActionsMaxPerElement = 8;
static const NSUInteger RunnerAXCustomActionNameMaxLength = 80;

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
                                           customActionLimit:(NSInteger)customActionLimit
                                                    deadline:(nullable NSDate *)deadline
{
  @try {
    id axClient = [self accessibilityClient];
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
    NSMutableArray<RunnerAXSnapshotFrontier *> *merged =
        customActionLimit > 0 ? [NSMutableArray array] : nil;
    NSMutableDictionary *rootNode = [self dictionaryForSnapshot:root
                                                          depth:0
                                                       maxDepth:maxDepth
                                                       maxNodes:maxNodes
                                                      nodeCount:&nodeCount
                                                      truncated:&truncated
                                                      frontiers:candidates
                                                    mergedLeaves:merged];
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
                                                   mergedLeaves:merged
                                                       deadline:deadline];
    CGRect rootFrame = CGRectZero;
    NSDictionary *rootFrameValue = rootNode[@"frame"];
    if ([rootFrameValue isKindOfClass:NSDictionary.class]) {
      rootFrame = CGRectMake(
        [rootFrameValue[@"x"] doubleValue], [rootFrameValue[@"y"] doubleValue],
        [rootFrameValue[@"width"] doubleValue], [rootFrameValue[@"height"] doubleValue]);
    }
    NSDictionary *customActions = [self annotateCustomActionsOnMergedLeaves:merged
                                                                   axClient:axClient
                                                                      limit:customActionLimit
                                                                  rootFrame:rootFrame
                                                                   deadline:deadline];

    NSMutableDictionary *response = [NSMutableDictionary dictionaryWithDictionary:@{
      RunnerAXSnapshotOkKey: @YES,
      RunnerAXSnapshotRootKey: rootNode,
      RunnerAXSnapshotTruncatedKey: @(truncated),
    }];
    if (nil != deepExtension) {
      response[RunnerAXSnapshotDeepExtensionKey] = deepExtension;
    }
    if (customActions.count > 0) {
      response[RunnerAXSnapshotCustomActionsKey] = customActions;
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
                                      mergedLeaves:(nullable NSMutableArray<RunnerAXSnapshotFrontier *> *)mergedLeaves
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
                                                         frontiers:subCandidates
                                                      mergedLeaves:mergedLeaves];
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

/// Reads custom actions for the merged leaves in traversal order until the
/// limit or the capture deadline is spent. Each read is its own AX round trip
/// (~100ms on an idle simulator), so this is strictly opt-in and strictly
/// bounded.
///
/// Returns {read, candidates} so the response can DISCLOSE an incomplete pass.
/// An unread element is byte-identical to one that genuinely has no actions, so
/// silence here would teach a reader that later cards have no affordances —
/// exactly the mis-inference this capture exists to prevent.
///
/// `candidates` counts only elements still eligible at read time: a leaf that
/// deep extension filled in since serialization is not a merged element, so
/// counting it would inflate the denominator with nodes that never needed a
/// read. A leaf whose live element vanished stays counted and unread, because
/// that one really is an element we failed to answer for.
///
/// On-screen candidates are read first. The budget is smaller than a long
/// feed's card count, so the order decides which elements an agent can act on
/// at all — and it also makes the disclosure's remedy true: scrolling changes
/// the on-screen set, so a re-run reads elements the previous pass could not.
/// Note that `--scope` deliberately is NOT the ordering key: scope is applied
/// when the Swift walk builds nodes, long after this pass, so it cannot narrow
/// the read budget without duplicating the scope predicate here.
+ (NSDictionary<NSString *, NSNumber *> *)
    annotateCustomActionsOnMergedLeaves:(nullable NSArray<RunnerAXSnapshotFrontier *> *)leaves
                               axClient:(id)axClient
                                  limit:(NSInteger)limit
                              rootFrame:(CGRect)rootFrame
                               deadline:(nullable NSDate *)deadline
{
  if (limit <= 0 || leaves.count == 0) {
    return @{};
  }
  NSMutableArray<RunnerAXSnapshotFrontier *> *onScreen = [NSMutableArray array];
  NSMutableArray<RunnerAXSnapshotFrontier *> *offScreen = [NSMutableArray array];
  for (RunnerAXSnapshotFrontier *leaf in leaves) {
    if ([leaf.node[@"children"] isKindOfClass:NSArray.class]
        && [(NSArray *)leaf.node[@"children"] count] > 0) {
      continue;
    }
    [([self isFrameOnScreen:leaf.node[@"frame"] rootFrame:rootFrame] ? onScreen : offScreen)
        addObject:leaf];
  }
  NSInteger candidates = onScreen.count + offScreen.count;
  NSInteger attempts = 0;
  NSInteger reads = 0;
  NSInteger annotated = 0;
  NSInteger truncatedElements = 0;
  BOOL blocked = NO;
  for (RunnerAXSnapshotFrontier *leaf in [onScreen arrayByAddingObjectsFromArray:offScreen]) {
    if (attempts >= limit || (nil != deadline && deadline.timeIntervalSinceNow <= 0)) {
      break;
    }
    // An abandoned read from an earlier capture is still outstanding. Stop the
    // pass here rather than spending a deadline per element on reads that will
    // all be refused, and record why so the response does not present the
    // unread elements as "has no actions".
    if ([self customActionReadsInFlight] > 0) {
      blocked = YES;
      break;
    }
    id element = [self accessibilityElementForSnapshot:leaf.snapshot];
    if (nil == element) {
      continue;
    }
    // The attempt is what the budget buys; only a completed read counts as
    // read, so a timed-out element stays in the undisclosed remainder instead
    // of being reported as "read, and it has no actions".
    attempts += 1;
    BOOL completed = NO;
    NSArray<NSString *> *names = [self customActionNamesForElement:element
                                                          axClient:axClient
                                                         completed:&completed];
    if (!completed) {
      continue;
    }
    reads += 1;
    BOOL truncated = NO;
    NSArray<NSString *> *capped = [self cappedActionNames:names ?: @[] truncated:&truncated];
    if (truncated) {
      truncatedElements += 1;
    }
    if (capped.count > 0) {
      leaf.node[@"actions"] = capped;
      annotated += 1;
    }
  }
  NSLog(
    @"AGENT_DEVICE_RUNNER_PRIVATE_AX_CUSTOM_ACTIONS reads=%ld attempts=%ld annotated=%ld "
     "candidates=%ld onScreen=%ld truncated=%ld blocked=%d dispatches=%ld",
    (long)reads, (long)attempts, (long)annotated, (long)candidates, (long)onScreen.count,
    (long)truncatedElements, (int)blocked, (long)[self customActionReadDispatchCount]);
  return @{
    RunnerAXSnapshotCustomActionsReadKey: @(reads),
    RunnerAXSnapshotCustomActionsCandidatesKey: @(candidates),
    RunnerAXSnapshotCustomActionsTruncatedKey: @(truncatedElements),
    RunnerAXSnapshotCustomActionsBlockedKey: @(blocked),
  };
}

/// An empty root frame means the capture has no viewport to judge against, so
/// every candidate counts as on-screen and the order stays document order.
+ (BOOL)isFrameOnScreen:(id)frameValue rootFrame:(CGRect)rootFrame
{
  if (CGRectIsEmpty(rootFrame)) {
    return YES;
  }
  if (![frameValue isKindOfClass:NSDictionary.class]) {
    return NO;
  }
  NSDictionary *frame = (NSDictionary *)frameValue;
  CGRect rect = CGRectMake(
    [frame[@"x"] doubleValue], [frame[@"y"] doubleValue],
    [frame[@"width"] doubleValue], [frame[@"height"] doubleValue]);
  return !CGRectIsEmpty(rect) && CGRectIntersectsRect(rect, rootFrame);
}

+ (nullable NSArray<NSString *> *)customActionNamesForElement:(id)element
                                                    axClient:(id)axClient
                                                   completed:(BOOL *)completed
{
  if (NULL != completed) {
    *completed = NO;
  }
  if (nil == element || nil == axClient) {
    return nil;
  }
  SEL selector = NSSelectorFromString(@"attributesForElement:attributes:error:");
  if (![axClient respondsToSelector:selector]) {
    return nil;
  }
  int expectedReadsInFlight = 0;
  if (!atomic_compare_exchange_strong(
        &RunnerAXCustomActionReadsInFlight, &expectedReadsInFlight, 1)) {
    atomic_fetch_add(&RunnerAXCustomActionReadBlocked, 1);
    return nil;
  }
  // The AX call is a synchronous XPC round trip with no timeout of its own, so
  // it runs off-thread behind a bounded wait. On timeout the result box is
  // never read, so a late-returning wedged call cannot race this thread.
  atomic_fetch_add(&RunnerAXCustomActionReadDispatches, 1);
  NSMutableArray *box = [NSMutableArray array];
  dispatch_semaphore_t finished = dispatch_semaphore_create(0);
  dispatch_async(RunnerAXCustomActionReadQueue(), ^{
    typedef id (*RunnerAXAttributesMsgSend)(id, SEL, id, id, NSError **);
    RunnerAXAttributesMsgSend send = (RunnerAXAttributesMsgSend)objc_msgSend;
    NSError *error = nil;
    id result = nil;
    @try {
      result = send(axClient, selector, element, @[ RunnerAXCustomActionsAttribute ], &error);
    } @catch (NSException *exception) {
      result = nil;
    }
    if (nil != result) {
      [box addObject:result];
    }
    // Clear in-flight BEFORE signalling, so a waiter that wakes on this signal
    // never observes its own completed read as still outstanding.
    atomic_store(&RunnerAXCustomActionReadsInFlight, 0);
    dispatch_semaphore_signal(finished);
  });
  long waited = dispatch_semaphore_wait(
    finished,
    dispatch_time(DISPATCH_TIME_NOW, (int64_t)(RunnerAXCustomActionReadTimeout * NSEC_PER_SEC)));
  if (waited != 0) {
    NSLog(@"AGENT_DEVICE_RUNNER_PRIVATE_AX_CUSTOM_ACTIONS_READ_TIMEOUT");
    return nil;
  }
  if (NULL != completed) {
    *completed = YES;
  }
  id values = box.firstObject;
  if (![values isKindOfClass:NSDictionary.class]) {
    return nil;
  }
  id actions = ((NSDictionary *)values)[RunnerAXCustomActionsAttribute];
  if (![actions isKindOfClass:NSArray.class]) {
    return nil;
  }
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  for (id action in (NSArray *)actions) {
    if (![action isKindOfClass:NSDictionary.class]) {
      continue;
    }
    id name = ((NSDictionary *)action)[@"CustomActionName"];
    if ([name isKindOfClass:NSString.class] && [(NSString *)name length] > 0) {
      [names addObject:name];
    }
  }
  return names.count > 0 ? names.copy : nil;
}

/// Bounds what one element can contribute to the response. The names come from
/// the app, so their count and length are the app's choice, not ours — a list
/// long enough to dominate a snapshot is a plausible accident (generated rows)
/// as well as a hostile case. Truncation is reported, never silent: a clipped
/// list is exactly as misleading as an unread element if it looks complete.
+ (NSArray<NSString *> *)cappedActionNames:(NSArray<NSString *> *)names
                                 truncated:(BOOL *)truncated
{
  if (NULL != truncated) {
    *truncated = NO;
  }
  NSMutableArray<NSString *> *capped = [NSMutableArray array];
  for (NSString *name in names) {
    if (capped.count >= RunnerAXCustomActionsMaxPerElement) {
      if (NULL != truncated) {
        *truncated = YES;
      }
      break;
    }
    if (name.length > RunnerAXCustomActionNameMaxLength) {
      // Clip on composed character boundaries so a truncated name stays a
      // valid string rather than a split grapheme.
      NSRange clip = [name rangeOfComposedCharacterSequencesForRange:
                             NSMakeRange(0, RunnerAXCustomActionNameMaxLength)];
      [capped addObject:[[name substringWithRange:clip] stringByAppendingString:@"…"]];
      if (NULL != truncated) {
        *truncated = YES;
      }
      continue;
    }
    [capped addObject:name];
  }
  return capped.copy;
}

+ (NSInteger)customActionReadsInFlight
{
  return atomic_load(&RunnerAXCustomActionReadsInFlight);
}

+ (NSInteger)customActionReadDispatchCount
{
  return (NSInteger)atomic_load(&RunnerAXCustomActionReadDispatches);
}

+ (NSInteger)customActionReadBlockedCount
{
  return (NSInteger)atomic_load(&RunnerAXCustomActionReadBlocked);
}

+ (nullable id)accessibilityClient
{
  return [self objectFrom:XCUIDevice.sharedDevice selectorName:@"accessibilityInterface"];
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
                                           mergedLeaves:(NSMutableArray<RunnerAXSnapshotFrontier *> *)mergedLeaves
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
                                                         frontiers:frontiers
                                                      mergedLeaves:mergedLeaves];
      if (nil != childNode) {
        [children addObject:childNode];
      }
      if (*nodeCount >= maxNodes) {
        *truncated = YES;
        break;
      }
    }
  }
  if (children.count == 0 && nil != mergedLeaves
      && [result[@"label"] isKindOfClass:NSString.class]
      && [(NSString *)result[@"label"] length] > 0) {
    // A labelled childless node is the shape a merged card takes: the container
    // is marked accessible, so its real controls never appear as children. Only
    // these are worth an action read — unlabelled leaves are decoration.
    RunnerAXSnapshotFrontier *candidate = [[RunnerAXSnapshotFrontier alloc] init];
    candidate.snapshot = snapshot;
    candidate.node = result;
    candidate.depth = depth;
    [mergedLeaves addObject:candidate];
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
