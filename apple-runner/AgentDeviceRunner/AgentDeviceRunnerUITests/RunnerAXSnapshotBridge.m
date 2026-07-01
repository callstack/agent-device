#import "RunnerAXSnapshotBridge.h"

#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>

static NSString *const RunnerAXSnapshotOkKey = @"ok";
static NSString *const RunnerAXSnapshotErrorKey = @"error";
static NSString *const RunnerAXSnapshotRootKey = @"root";
static NSString *const RunnerAXSnapshotTruncatedKey = @"truncated";

typedef id (*RunnerAXObjectMsgSend)(id, SEL);
typedef NSInteger (*RunnerAXIntegerMsgSend)(id, SEL);
typedef id (*RunnerAXSnapshotMsgSend)(id, SEL, id, id, id, NSError **);

@implementation RunnerAXSnapshotBridge

+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes
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

    NSMutableDictionary *parameters = [NSMutableDictionary dictionary];
    id defaults = [self objectFrom:axClient selectorName:@"defaultParameters"];
    if ([defaults isKindOfClass:NSDictionary.class]) {
      [parameters addEntriesFromDictionary:(NSDictionary *)defaults];
    }
    parameters[@"maxDepth"] = @(MAX(0, maxDepth));
    parameters[@"maxChildren"] = @(MAX(1, maxNodes));
    parameters[@"maxArrayCount"] = @(MAX(1, maxNodes));
    parameters[@"traverseFromParentsToChildren"] = @YES;

    SEL requestSelector = NSSelectorFromString(@"requestSnapshotForElement:attributes:parameters:error:");
    if (![axClient respondsToSelector:requestSelector]) {
      return [self failure:@"AX client does not support requestSnapshotForElement"];
    }

    NSError *error = nil;
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
    RunnerAXSnapshotMsgSend send = (RunnerAXSnapshotMsgSend)objc_msgSend;
    id result = send(axClient, requestSelector, target, attributes, parameters.copy, &error);
    if (nil == result) {
      return [self failure:error.localizedDescription ?: @"AX snapshot request returned nil"];
    }

    id root = nil;
    @try {
      root = [result valueForKey:@"_rootElementSnapshot"];
    } @catch (NSException *exception) {
      root = nil;
    }
    if (nil == root) {
      root = result;
    }

    BOOL truncated = NO;
    NSInteger nodeCount = 0;
    NSDictionary *rootNode = [self dictionaryForSnapshot:root
                                                   depth:0
                                                maxDepth:maxDepth
                                                maxNodes:maxNodes
                                               nodeCount:&nodeCount
                                               truncated:&truncated];
    if (nil == rootNode) {
      return [self failure:@"AX snapshot root could not be serialized"];
    }

    return @{
      RunnerAXSnapshotOkKey: @YES,
      RunnerAXSnapshotRootKey: rootNode,
      RunnerAXSnapshotTruncatedKey: @(truncated),
    };
  } @catch (NSException *exception) {
    return [self failure:exception.reason ?: exception.name ?: @"AX snapshot bridge exception"];
  }
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

+ (nullable NSDictionary *)dictionaryForSnapshot:(id)snapshot
                                           depth:(NSInteger)depth
                                        maxDepth:(NSInteger)maxDepth
                                        maxNodes:(NSInteger)maxNodes
                                       nodeCount:(NSInteger *)nodeCount
                                       truncated:(BOOL *)truncated
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
      NSDictionary *childNode = [self dictionaryForSnapshot:child
                                                      depth:depth + 1
                                                   maxDepth:maxDepth
                                                   maxNodes:maxNodes
                                                  nodeCount:nodeCount
                                                  truncated:truncated];
      if (nil != childNode) {
        [children addObject:childNode];
      }
      if (*nodeCount >= maxNodes) {
        *truncated = YES;
        break;
      }
    }
  }
  result[@"children"] = children;
  return result.copy;
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
