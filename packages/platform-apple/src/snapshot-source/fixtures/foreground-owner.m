#import "SnapshotBridgeRuntime.h"
#import "SnapshotBridgeCapture.h"

#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>

static id primaryApplication;
static id replacementApplication;
static NSUInteger captureCount;
static NSString *captureScenario;

@interface AXElement : NSObject
@property(nonatomic) pid_t pid;
+ (id)primaryApp;
@end

@implementation AXElement
+ (id)primaryApp { return primaryApplication; }
@end

@interface XCAccessibilityElement : NSObject
+ (instancetype)elementWithProcessIdentifier:(pid_t)pid;
- (void *)AXUIElement;
@end

@implementation XCAccessibilityElement
+ (instancetype)elementWithProcessIdentifier:(pid_t)pid { return [self new]; }
- (void *)AXUIElement { return (__bridge void *)self; }
@end

@interface XCTAccessibilityFramework : NSObject
- (instancetype)initForRemoteAccess;
- (id)userTestingSnapshotForElement:(id)element options:(NSDictionary *)options error:(NSError **)error;
@end

@implementation XCTAccessibilityFramework
- (instancetype)initForRemoteAccess { return [super init]; }
- (id)userTestingSnapshotForElement:(id)element options:(NSDictionary *)options error:(NSError **)error
{
  captureCount++;
  if ([captureScenario isEqual:@"runtime-budget"]) {
    BOOL root = ![element isKindOfClass:NSNumber.class];
    NSMutableArray *children = [NSMutableArray array];
    for (NSUInteger i = 0; i < (root ? 40 : 1); i++) [children addObject:@{
        @"UIAccessibilitySnapshotKeyAttributes": @{}, @"UIAccessibilitySnapshotKeyChildren": @[],
        @"UIAccessibilitySnapshotKeyElement": @(i), @"UIAccessibilitySnapshotKeyChildrenCount": @(root ? 1 : 0)}];
    return @{@"UIAccessibilitySnapshotKeyAttributes": @{}, @"UIAccessibilitySnapshotKeyChildren": children};
  }
  if ([captureScenario isEqual:@"rejected"]) {
    if (error) *error = [NSError errorWithDomain:@"AX" code:-25201 userInfo:@{@"accessibility-error": @(-25201)}];
    return nil;
  }
  if ([captureScenario isEqual:@"unavailable"]) {
    if (error) *error = [NSError errorWithDomain:@"unavailable" code:5
        userInfo:@{NSLocalizedDescriptionKey:@"Error kAXErrorIllegalArgument"}];
    return nil;
  }
  if ([captureScenario hasPrefix:@"wide-"] || [captureScenario isEqual:@"zero-depth"]) {
    NSMutableArray *children = [NSMutableArray array];
    NSUInteger limit = [options[@"maxChildren"] unsignedIntegerValue];
    if ([captureScenario isEqual:@"wide-continuation"] && captureCount == 1) limit = 0;
    for (NSUInteger i = 0; i < MIN(10, limit); i++) {
      [children addObject:@{@"UIAccessibilitySnapshotKeyAttributes": @{@2: @(i).stringValue},
                            @"UIAccessibilitySnapshotKeyChildren": @[]}];
    }
    return @{@"UIAccessibilitySnapshotKeyAttributes": @{@2: @"fixture app"},
             @"UIAccessibilitySnapshotKeyElement": element,
             @"UIAccessibilitySnapshotKeyChildrenCount": @10,
             @"UIAccessibilitySnapshotKeyChildren": children};
  }
  if ([captureScenario hasPrefix:@"depth-"]) {
    NSUInteger requested = [options[@"maxDepth"] unsignedIntegerValue];
    if (requested > 4) {
      if (error) *error = [NSError errorWithDomain:@"AX" code:-25201 userInfo:@{@"accessibility-error": @(-25201)}];
      if ([captureScenario isEqual:@"depth-wrapper"]) {
        if (error) *error = [NSError errorWithDomain:@"com.apple.dt.xctest.automation-support.error" code:5 userInfo:nil];
      }
      return nil;
    }
    NSUInteger level = [element isKindOfClass:NSNumber.class] ? [element unsignedIntegerValue] : 0;
    NSMutableDictionary *tree = nil;
    for (NSInteger i = MIN(level + requested, 7) - 1; i >= (NSInteger)level; i--) {
      tree = [@{@"UIAccessibilitySnapshotKeyAttributes": @{@2: @(i).stringValue},
                @"UIAccessibilitySnapshotKeyElement": @(i),
                @"UIAccessibilitySnapshotKeyChildrenCount": @(i < 6 ? 1 : 0),
                @"UIAccessibilitySnapshotKeyChildren": tree ? @[tree] : @[]} mutableCopy];
    }
    if ([@[@"depth-missing-element", @"depth-missing-count", @"depth-invalid-count", @"depth-fractional-count", @"depth-nan-count", @"depth-negative-count"] containsObject:captureScenario] || ([captureScenario isEqual:@"depth-continuation-count"] && level > 0)) {
      NSMutableDictionary *frontier = tree;
      while ([frontier[@"UIAccessibilitySnapshotKeyChildren"] count]) frontier = [frontier[@"UIAccessibilitySnapshotKeyChildren"] firstObject];
      if ([captureScenario isEqual:@"depth-missing-element"]) [frontier removeObjectForKey:@"UIAccessibilitySnapshotKeyElement"];
      else if ([captureScenario isEqual:@"depth-missing-count"] || [captureScenario isEqual:@"depth-continuation-count"]) [frontier removeObjectForKey:@"UIAccessibilitySnapshotKeyChildrenCount"];
      else frontier[@"UIAccessibilitySnapshotKeyChildrenCount"] = [captureScenario isEqual:@"depth-fractional-count"] ? @0.5 : [captureScenario isEqual:@"depth-nan-count"] ? @(NAN) : [captureScenario isEqual:@"depth-negative-count"] ? @(-1) : [NSNull null];
    }
    if ([captureScenario isEqual:@"depth-incomplete"] && level > 0) tree[@"UIAccessibilitySnapshotKeyChildren"] = @[];
    if ([captureScenario isEqual:@"depth-owner-change"] && level > 0) primaryApplication = replacementApplication;
    return tree;
  }
  if (replacementApplication) primaryApplication = replacementApplication;
  return @{ @"UIAccessibilitySnapshotKeyAttributes": @{ @2: @"fixture app" },
            @"UIAccessibilitySnapshotKeyChildren": @[] };
}
@end

@interface FixtureRuntime : BridgeRuntime
@end
@implementation FixtureRuntime
- (BOOL)assertAutomationMode:(BOOL)wanted { return YES; }
@end

static NSDictionary *defaultParameters(void) { return @{}; }
static NSArray *attributeNumbers(NSArray *names)
{
  NSMutableArray *numbers = [NSMutableArray array];
  for (NSUInteger index = 0; index < names.count; index++) [numbers addObject:@(index)];
  return numbers;
}
static uint32_t valueType(const void *value) { return 0; }
static Boolean valueGet(const void *value, uint32_t type, void *out) { return false; }

void *fixtureDlopen(const char *path, int mode) { return NULL; }
void *fixtureDlsym(void *handle, const char *symbol)
{
  if (!strcmp(symbol, "XCTDefaultSnapshotParameters")) return (void *)defaultParameters;
  if (!strcmp(symbol, "XCAXAccessibilityAttributesForStringAttributes")) return (void *)attributeNumbers;
  if (!strcmp(symbol, "AXValueGetType")) return (void *)valueType;
  if (!strcmp(symbol, "AXValueGetValue")) return (void *)valueGet;
  return NULL;
}

NSDictionary *failureResponse(NSString *requestId, NSString *kind, NSString *code, NSString *message)
{
  return @{ @"requestId": requestId, @"error_kind": kind, @"error_code": code, @"error": message };
}

static void require(BOOL condition, NSString *message)
{
  if (condition) return;
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(1);
}

int main(int argc, const char *argv[])
{
  @autoreleasepool {
    require(argc == 2, @"one capture scenario is required");
    NSString *scenario = @(argv[1]);
    if ([scenario isEqual:@"identity"] || [scenario isEqual:@"request-budget"] || [scenario hasPrefix:@"api-depth-"]) {
      BOOL budget = [scenario isEqual:@"request-budget"];
      NSUInteger depth = [scenario hasPrefix:@"api-depth-"] ? [[scenario substringFromIndex:10] integerValue] : 64;
      NSMutableArray *children = [NSMutableArray array];
      for (NSUInteger i = 0; i < (budget ? 40 : 2); i++) {
        [children addObject:@{@"UIAccessibilitySnapshotKeyAttributes": @{}, @"UIAccessibilitySnapshotKeyChildren": @[],
            @"UIAccessibilitySnapshotKeyElement": @(i), @"UIAccessibilitySnapshotKeyChildrenCount": @(budget ? 1 : 0)}];
      }
      NSDictionary *root = @{@"UIAccessibilitySnapshotKeyAttributes": @{}, @"UIAccessibilitySnapshotKeyChildren": children};
      __block NSUInteger requests = 0;
      BOOL truncated = NO;
      NSError *failure = nil;
      NSDictionary *result = captureSnapshotTree(@"root", depth, 1000, 0, ^id(id element, NSUInteger levels, NSUInteger nodes, NSError **error) {
        requests++;
        if ([scenario hasPrefix:@"api-depth-"]) {
          require(levels == depth + 1, @"native levels must include the root exactly once");
          NSDictionary *tree = nil;
          for (NSUInteger i = 0; i < levels; i++) tree = @{@"UIAccessibilitySnapshotKeyAttributes": @{}, @"UIAccessibilitySnapshotKeyChildrenCount": [scenario isEqual:@"api-depth-unknown"] ? [NSNull null] : @(tree ? 1 : 0), @"UIAccessibilitySnapshotKeyChildren": tree ? @[tree] : @[]};
          return tree;
        }
        if ([element isEqual:@"root"]) return root;
        return @{@"UIAccessibilitySnapshotKeyAttributes": @{}, @"UIAccessibilitySnapshotKeyChildren": @[@{@"UIAccessibilitySnapshotKeyAttributes": @{}, @"UIAccessibilitySnapshotKeyChildren": @[]}]};
      }, &truncated, NULL, &failure);
      if (budget) require(!result && failure.code == 1 && requests == 32, @"request budget must fail without publishing partial content");
      else if ([scenario isEqual:@"identity"]) require(result == root && requests == 1, @"healthy capture must reuse the native tree");
      else {
        NSUInteger count = 0;
        for (NSDictionary *node = result; node; node = [node[@"UIAccessibilitySnapshotKeyChildren"] firstObject]) count++;
        require(count == depth + 1 && truncated == [scenario isEqual:@"api-depth-unknown"] && requests == 1, @"every requested depth must include root plus permitted descendants");
      }
      return 0;
    }
    captureScenario = scenario;
    AXElement *target = [AXElement new];
    target.pid = 42;
    AXElement *system = [AXElement new];
    system.pid = 7;

    primaryApplication = target;
    NSString *expectedCode = nil;
    NSUInteger expectedCaptures = 0;
    if ([scenario isEqual:@"runtime-budget"]) {
      expectedCaptures = 32;
      expectedCode = @"continuation-budget-exhausted";
    } else if ([scenario hasPrefix:@"wide-"] || [scenario isEqual:@"zero-depth"]) {
      expectedCaptures = [scenario isEqual:@"wide-continuation"] ? 2 : 1;
    } else if ([scenario hasPrefix:@"depth-"]) {
      expectedCaptures = [scenario isEqual:@"depth-bound"] ? 5 : [scenario isEqual:@"depth-nodes"] ? 2 : 3;
      if ([@[@"depth-missing-element", @"depth-incomplete", @"depth-missing-count", @"depth-invalid-count", @"depth-continuation-count", @"depth-fractional-count", @"depth-nan-count", @"depth-negative-count"] containsObject:scenario]) {
        expectedCode = @"snapshot-tree-malformed";
        if (![scenario isEqual:@"depth-incomplete"] && ![scenario isEqual:@"depth-continuation-count"]) expectedCaptures = 2;
      }
      if ([scenario isEqual:@"depth-owner-change"]) {
        replacementApplication = system;
        expectedCode = @"foreground-owner-changed";
      }
    } else if ([scenario isEqual:@"unavailable"] || [scenario isEqual:@"rejected"]) {
      expectedCaptures = [scenario isEqual:@"rejected"] ? 3 : 1;
      expectedCode = @"application-server-unavailable";
    } else if ([scenario isEqualToString:@"stable"]) {
      expectedCaptures = 1;
    } else if ([scenario isEqualToString:@"changed"]) {
      replacementApplication = system;
      expectedCode = @"foreground-owner-changed";
      expectedCaptures = 1;
    } else {
      require([@[@"covered", @"missing", @"malformed"] containsObject:scenario], @"unknown scenario");
      primaryApplication = [scenario isEqualToString:@"covered"] ? system :
          [scenario isEqualToString:@"missing"] ? nil : @"invalid";
      expectedCode = @"foreground-owner-unverified";
    }

    NSString *setupError = nil;
    BridgeRuntime *runtime = [[FixtureRuntime alloc] initWithError:&setupError];
    require(runtime != nil, setupError ?: @"fixture initialization failed");
    NSDictionary *error = nil;
    NSDictionary *result = [runtime snapshotForProcess:42 maxDepth:([scenario isEqual:@"zero-depth"] ? 0 : [scenario isEqual:@"depth-bound"] ? 4 : 8) maxNodes:(([scenario isEqual:@"depth-nodes"] || [scenario hasPrefix:@"wide-"]) ? 3 : [scenario isEqual:@"runtime-budget"] ? 1000 : 10)
        nativeLevelsHint:0 requestId:@"capture-1" generation:@"generation-1" maxDurationMs:4000 error:&error];
    if (expectedCode) {
      require(result == nil, @"refused capture must not publish the app tree");
      require([error[@"error_kind"] isEqual:([expectedCode isEqual:@"application-server-unavailable"] ? @"application_unavailable" : [expectedCode isEqual:@"snapshot-tree-malformed"] ? @"malformed_tree" : [expectedCode isEqual:@"continuation-budget-exhausted"] ? @"reader_unavailable" : @"unsupported")], @"refusal must preserve the typed failure kind");
      require([error[@"error_code"] isEqual:expectedCode], @"refusal must name the ownership phase");
      require([error[@"requestId"] isEqual:@"capture-1"], @"refusal must preserve request identity");
    } else {
      require(error == nil && [result[@"ok"] boolValue], @"stable foreground must publish successfully");
      if ([scenario hasPrefix:@"wide-"] || [scenario isEqual:@"zero-depth"]) {
        require([result[@"truncated"] boolValue], @"bounded capture must disclose omitted content");
        NSArray *children = result[@"tree"][@"XC_kAXXCAttributeChildren"];
        require(children.count == ([scenario isEqual:@"zero-depth"] ? 0 : 2), @"bounded capture must retain the permitted children");
        if (children.count) require([children[1][@"XC_kAXXCAttributeLabel"] isEqual:@"1"], @"bounded capture must preserve sibling order");
      } else if ([scenario isEqual:@"depth-bound"] || [scenario isEqual:@"depth-nodes"]) {
        require([result[@"truncated"] boolValue], @"bounded capture must disclose omitted content");
        NSDictionary *node = result[@"tree"];
        NSUInteger count = 1;
        while ([node[@"XC_kAXXCAttributeChildren"] count]) {node = [node[@"XC_kAXXCAttributeChildren"] firstObject]; count++;}
        require(count == ([scenario isEqual:@"depth-bound"] ? 5 : 3), @"bounded capture must retain every allowed node");
      } else if ([scenario hasPrefix:@"depth-"]) {
        NSDictionary *node = result[@"tree"];
        for (NSUInteger i = 0; i < 6; i++) node = [node[@"XC_kAXXCAttributeChildren"] firstObject];
        require([node[@"XC_kAXXCAttributeLabel"] isEqual:@"6"], @"recovery must retain the deepest content");
        require(![result[@"truncated"] boolValue], @"complete recovered tree must remain complete");
      } else require([result[@"tree"][@"XC_kAXXCAttributeLabel"] isEqual:@"fixture app"], @"stable capture must publish the materialized app tree");
    }
    require(captureCount == expectedCaptures, @"covered apps must be refused before native acquisition");
  }
  return 0;
}
