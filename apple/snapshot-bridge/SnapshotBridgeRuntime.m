/*
 * The private Simulator AX reader is adapted from Meta Platforms, Inc. idb v1.5.2
 * SimulatorFrameworkBridge/AccessibilityService.m and AccessibilityRuntime.m.
 * See LICENSE.idb for the upstream notice and license.
 */

#import "SnapshotBridgeRuntime.h"

#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#import <objc/runtime.h>

#import <dlfcn.h>
#import <signal.h>
#import <unistd.h>

NSString *const kProtocolVersionKey = @"protocolVersion";
NSString *const kSourceVersionKey = @"sourceVersion";
NSString *const kRequestIdKey = @"requestId";
NSString *const kSourceVersion = @"agent-device-simulator-ax-v1.5.3";
const NSUInteger kProtocolVersion = 1;
const uint32_t kMaximumFrameBytes = 16 * 1024 * 1024;
const NSUInteger kMaximumDepth = 128;
const NSUInteger kMaximumNodes = 10000;
const NSUInteger kMaximumDurationMs = 120000;

static NSString *const kAttributeElementType = @"XC_kAXXCAttributeElementType";
static NSString *const kAttributeElementBaseType = @"XC_kAXXCAttributeElementBaseType";
static NSString *const kAttributeLabel = @"XC_kAXXCAttributeLabel";
static NSString *const kAttributeValue = @"XC_kAXXCAttributeValue";
static NSString *const kAttributeIdentifier = @"XC_kAXXCAttributeIdentifier";
static NSString *const kAttributeFrame = @"XC_kAXXCAttributeFrame";
static NSString *const kAttributeAutomationType = @"XC_kAXXCAttributeAutomationType";
static NSString *const kAttributeChildren = @"XC_kAXXCAttributeChildren";
static NSString *const kSnapshotAttributes = @"UIAccessibilitySnapshotKeyAttributes";
static NSString *const kSnapshotChildren = @"UIAccessibilitySnapshotKeyChildren";
static NSString *const kXctAutomationSupportPath =
    @"/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework/XCTAutomationSupport";
static NSString *const kAxRuntimePath =
    @"/System/Library/PrivateFrameworks/AXRuntime.framework/AXRuntime";
static NSString *const kAccessibilityErrorKey = @"accessibility-error";

typedef NSDictionary<NSString *, id> *_Nullable (*DefaultSnapshotParametersFn)(void);
typedef NSArray<NSNumber *> *_Nullable (*AttributeNumbersForNamesFn)(NSArray<NSString *> *names);
typedef uint32_t (*AXValueGetTypeFn)(const void *value);
typedef Boolean (*AXValueGetValueFn)(const void *value, uint32_t type, void *out);
typedef bool (*AutomationEnabledFn)(void);

@interface XCTAccessibilityFramework : NSObject
- (instancetype)initForRemoteAccess;
- (nullable id)userTestingSnapshotForElement:(id)element
                                      options:(NSDictionary<NSString *, id> *)options
                                        error:(NSError **)error;
@end

@interface XCAccessibilityElement : NSObject
- (nullable void *)AXUIElement;
@end

@protocol XCAccessibilityElementFactory <NSObject>
+ (nullable XCAccessibilityElement *)elementWithProcessIdentifier:(pid_t)pid;
@end

static NSNumber *finiteNumber(double value)
{
  return isfinite(value) ? @(value) : nil;
}

static NSDictionary *_Nullable rectDictionary(CGRect rect)
{
  NSNumber *x = finiteNumber(rect.origin.x);
  NSNumber *y = finiteNumber(rect.origin.y);
  NSNumber *width = finiteNumber(rect.size.width);
  NSNumber *height = finiteNumber(rect.size.height);
  if (!x || !y || !width || !height) {
    return nil;
  }
  return @{ @"X" : x, @"Y" : y, @"Width" : width, @"Height" : height };
}

@interface SnapshotWatchdogState : NSObject
@property(atomic) BOOL completed;
@end

@implementation SnapshotWatchdogState
@end

static dispatch_source_t startRequestWatchdog(NSUInteger durationMs, SnapshotWatchdogState *state)
{
  dispatch_source_t watchdog = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER,
      0,
      0,
      dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  dispatch_source_set_timer(
      watchdog,
      dispatch_time(DISPATCH_TIME_NOW, (uint64_t)durationMs * NSEC_PER_MSEC),
      DISPATCH_TIME_FOREVER,
      0);
  dispatch_source_set_event_handler(watchdog, ^{
    if (!state.completed) kill(getpid(), SIGKILL);
  });
  dispatch_resume(watchdog);
  return watchdog;
}

static void finishRequestWatchdog(dispatch_source_t watchdog, SnapshotWatchdogState *state)
{
  state.completed = YES;
  dispatch_source_cancel(watchdog);
}

@implementation BridgeRuntime {
  XCTAccessibilityFramework *_framework;
  Class<XCAccessibilityElementFactory> _elementClass;
  DefaultSnapshotParametersFn _defaultSnapshotParameters;
  AttributeNumbersForNamesFn _attributeNumbersForNames;
  AXValueGetTypeFn _valueGetType;
  AXValueGetValueFn _valueGetValue;
  AutomationEnabledFn _automationEnabled;
}

- (nullable instancetype)initWithError:(NSString *_Nullable *_Nullable)error
{
  self = [super init];
  if (!self) return nil;

  dlopen(kAxRuntimePath.UTF8String, RTLD_NOW);
  dlopen(kXctAutomationSupportPath.UTF8String, RTLD_NOW);

  Class frameworkClass = objc_lookUpClass("XCTAccessibilityFramework");
  _elementClass = (Class<XCAccessibilityElementFactory>)objc_lookUpClass("XCAccessibilityElement");
  if (!frameworkClass || !_elementClass) {
    if (error) *error = @"XCTAutomationSupport accessibility classes are unavailable";
    return nil;
  }

  _framework = [(XCTAccessibilityFramework *)[frameworkClass alloc] initForRemoteAccess];
  if (!_framework || ![_framework respondsToSelector:@selector(userTestingSnapshotForElement:options:error:)]) {
    if (error) *error = @"XCTAccessibilityFramework snapshot API is unavailable";
    return nil;
  }

  _defaultSnapshotParameters = (DefaultSnapshotParametersFn)dlsym(RTLD_DEFAULT, "XCTDefaultSnapshotParameters");
  _attributeNumbersForNames = (AttributeNumbersForNamesFn)dlsym(
      RTLD_DEFAULT, "XCAXAccessibilityAttributesForStringAttributes");
  _valueGetType = (AXValueGetTypeFn)dlsym(RTLD_DEFAULT, "AXValueGetType");
  _valueGetValue = (AXValueGetValueFn)dlsym(RTLD_DEFAULT, "AXValueGetValue");
  _automationEnabled = (AutomationEnabledFn)dlsym(RTLD_DEFAULT, "_AXSAutomationEnabled");
  if (!_defaultSnapshotParameters || !_attributeNumbersForNames || !_valueGetType || !_valueGetValue) {
    if (error) *error = @"AX snapshot conversion functions are unavailable";
    return nil;
  }
  return self;
}

- (BOOL)assertAutomationMode:(BOOL)wanted
{
  Class settingsClass = NSClassFromString(@"AXSettings");
  SEL sharedInstance = NSSelectorFromString(@"sharedInstance");
  SEL setter = NSSelectorFromString(@"setAutomationEnabled:");
  if (settingsClass && [settingsClass respondsToSelector:sharedInstance]) {
    id settings = ((id (*)(id, SEL))objc_msgSend)(settingsClass, sharedInstance);
    if ([settings respondsToSelector:setter]) {
      ((void (*)(id, SEL, BOOL))objc_msgSend)(settings, setter, wanted);
    }
  }
  return _automationEnabled != NULL && _automationEnabled();
}

- (nullable id)jsonValue:(id)value name:(NSString *)name
{
  if (!value || value == [NSNull null]) return nil;
  if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) return value;

  const void *raw = (__bridge const void *)value;
  if (_valueGetType(raw) == 3) {
    CGRect rect = CGRectZero;
    if (_valueGetValue(raw, 3, &rect)) return rectDictionary(rect);
  }
  if ([name isEqualToString:kAttributeFrame]) return nil;
  return nil;
}

- (nullable NSDictionary *)nodeFromSnapshot:(id)snapshot
                              namesByNumber:(NSDictionary<NSNumber *, NSString *> *)namesByNumber
                                      depth:(NSUInteger)depth
                                   maxDepth:(NSUInteger)maxDepth
                                   maxNodes:(NSUInteger)maxNodes
                                      count:(NSUInteger *)count
                                  truncated:(BOOL *)truncated
                                  malformed:(BOOL *)malformed
{
  if (![snapshot isKindOfClass:NSDictionary.class]) {
    *malformed = YES;
    return nil;
  }
  if (*count >= maxNodes) {
    *truncated = YES;
    return nil;
  }
  (*count)++;

  NSDictionary *attributes = ((NSDictionary *)snapshot)[kSnapshotAttributes];
  if (![attributes isKindOfClass:NSDictionary.class]) {
    *malformed = YES;
    return nil;
  }
  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  for (NSNumber *number in attributes) {
    NSString *name = namesByNumber[number];
    if (!name || [name isEqualToString:kAttributeChildren]) continue;
    id safe = [self jsonValue:attributes[number] name:name];
    if (safe) node[name] = safe;
  }

  NSArray *children = ((NSDictionary *)snapshot)[kSnapshotChildren];
  if (![children isKindOfClass:NSArray.class]) {
    *malformed = YES;
    return nil;
  }
  NSMutableArray *builtChildren = [NSMutableArray array];
  if (depth >= maxDepth) {
    if (children.count > 0) *truncated = YES;
  } else {
    for (id child in children) {
      NSDictionary *built = [self nodeFromSnapshot:child
                                     namesByNumber:namesByNumber
                                             depth:depth + 1
                                          maxDepth:maxDepth
                                             maxNodes:maxNodes
                                             count:count
                                         truncated:truncated
                                         malformed:malformed];
      if (built) [builtChildren addObject:built];
      if (*malformed) return nil;
      if (*truncated) break;
      if (*count >= maxNodes) {
        if (builtChildren.count < children.count) *truncated = YES;
        break;
      }
    }
  }
  node[kAttributeChildren] = builtChildren;
  return node;
}

- (nullable NSDictionary *)snapshotForProcess:(pid_t)pid
                                    maxDepth:(NSUInteger)maxDepth
                                    maxNodes:(NSUInteger)maxNodes
                                  requestId:(NSString *)requestId
                                generation:(NSString *)generation
                              maxDurationMs:(NSUInteger)maxDurationMs
                                      error:(NSDictionary *_Nullable *_Nonnull)error
{
  SnapshotWatchdogState *watchdogState = [SnapshotWatchdogState new];
  dispatch_source_t watchdog = startRequestWatchdog(maxDurationMs, watchdogState);
  XCAccessibilityElement *root = [_elementClass elementWithProcessIdentifier:pid];
  if (!root) {
    if (error) *error = failureResponse(requestId, @"application_unavailable", @"application-element-missing", @"application element is unavailable");
    finishRequestWatchdog(watchdog, watchdogState);
    return nil;
  }
  void *raw = [root AXUIElement];
  if (!raw) {
    if (error) *error = failureResponse(requestId, @"application_unavailable", @"application-element-missing", @"application element is unavailable");
    finishRequestWatchdog(watchdog, watchdogState);
    return nil;
  }

  NSArray<NSString *> *names = @[
    kAttributeElementType,
    kAttributeElementBaseType,
    kAttributeLabel,
    kAttributeValue,
    kAttributeIdentifier,
    kAttributeFrame,
    kAttributeAutomationType,
    kAttributeChildren,
  ];
  NSArray<NSNumber *> *numbers = _attributeNumbersForNames(names);
  if (![numbers isKindOfClass:NSArray.class] || numbers.count != names.count) {
    if (error) *error = failureResponse(requestId, @"reader_unavailable", @"attribute-vocabulary-mismatch", @"AX attribute vocabulary is incompatible");
    finishRequestWatchdog(watchdog, watchdogState);
    return nil;
  }
  NSMutableDictionary<NSNumber *, NSString *> *namesByNumber = [NSMutableDictionary dictionary];
  [numbers enumerateObjectsUsingBlock:^(NSNumber *number, NSUInteger index, BOOL *stop) {
    (void)stop;
    if ([number isKindOfClass:NSNumber.class]) namesByNumber[number] = names[index];
  }];
  NSMutableDictionary *options = [_defaultSnapshotParameters() mutableCopy];
  if (!options) options = [NSMutableDictionary dictionary];
  options[@"attributes"] = numbers;
  options[@"maxDepth"] = @(maxDepth);
  options[@"maxChildren"] = @(maxNodes);
  options[@"maxArrayCount"] = @(maxNodes);
  BOOL automationEnabled = [self assertAutomationMode:YES];
  NSError *runtimeError = nil;
  id snapshot = nil;
  @try {
    snapshot = [_framework userTestingSnapshotForElement:(__bridge id)raw options:options error:&runtimeError];
  } @catch (NSException *exception) {
    if (error) *error = failureResponse(requestId, @"reader_unavailable", @"private-api-exception", exception.reason ?: @"AX snapshot raised an exception");
    finishRequestWatchdog(watchdog, watchdogState);
    return nil;
  }
  if (!snapshot) {
    NSNumber *axError = runtimeError.userInfo[kAccessibilityErrorKey];
    NSInteger code = [axError respondsToSelector:@selector(integerValue)] ? axError.integerValue : runtimeError.code;
    NSString *kind = code == -25216 ? @"application_not_responding" : @"application_unavailable";
    NSString *message = runtimeError.localizedDescription ?: @"AX snapshot returned no tree";
    if (error) *error = failureResponse(requestId, kind, code == -25216 ? @"application-timeout" : @"application-server-unavailable", message);
    finishRequestWatchdog(watchdog, watchdogState);
    return nil;
  }
  BOOL truncated = NO;
  BOOL malformed = NO;
  NSUInteger count = 0;
  NSDictionary *tree = [self nodeFromSnapshot:snapshot
                                namesByNumber:namesByNumber
                                        depth:0
                                     maxDepth:maxDepth
                                        maxNodes:maxNodes
                                        count:&count
                                    truncated:&truncated
                                    malformed:&malformed];
  if (!tree) {
    if (error) *error = failureResponse(requestId, @"malformed_tree", malformed ? @"snapshot-tree-malformed" : @"snapshot-root-invalid", malformed ? @"AX snapshot contained a malformed node" : @"AX snapshot did not contain a materialized root node");
    finishRequestWatchdog(watchdog, watchdogState);
    return nil;
  }
  finishRequestWatchdog(watchdog, watchdogState);
  return @{
    kProtocolVersionKey : @(kProtocolVersion),
    kSourceVersionKey : kSourceVersion,
    kRequestIdKey : requestId ?: @"",
    @"generation" : generation ?: @"",
    @"ok" : @YES,
    @"pid" : @(pid),
    @"tree" : tree,
    @"truncated" : @(truncated),
    @"automationEnabled" : @(automationEnabled),
  };
}
@end
BridgeRuntime *sharedRuntime(NSString **error)
{
  static BridgeRuntime *runtime;
  static dispatch_once_t once;
  static NSString *setupError;
  dispatch_once(&once, ^{
    NSString *localError = nil;
    runtime = [[BridgeRuntime alloc] initWithError:&localError];
    setupError = [localError copy];
  });
  if (!runtime && error) *error = setupError ?: @"AX bridge runtime is unavailable";
  return runtime;
}
