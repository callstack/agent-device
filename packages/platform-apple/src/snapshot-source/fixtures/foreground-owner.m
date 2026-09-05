#import "SnapshotBridgeRuntime.h"

#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>

static id primaryApplication;
static id replacementApplication;
static NSUInteger captureCount;

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
    AXElement *target = [AXElement new];
    target.pid = 42;
    AXElement *system = [AXElement new];
    system.pid = 7;

    primaryApplication = target;
    NSString *expectedCode = nil;
    NSUInteger expectedCaptures = 0;
    if ([scenario isEqualToString:@"stable"]) {
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
    NSDictionary *result = [runtime snapshotForProcess:42 maxDepth:8 maxNodes:10
        requestId:@"capture-1" generation:@"generation-1" maxDurationMs:4000 error:&error];
    if (expectedCode) {
      require(result == nil, @"refused capture must not publish the app tree");
      require([error[@"error_kind"] isEqual:@"unsupported"], @"refusal must preserve the typed failure kind");
      require([error[@"error_code"] isEqual:expectedCode], @"refusal must name the ownership phase");
      require([error[@"requestId"] isEqual:@"capture-1"], @"refusal must preserve request identity");
    } else {
      require(error == nil && [result[@"ok"] boolValue], @"stable foreground must publish successfully");
      require([result[@"tree"][@"XC_kAXXCAttributeLabel"] isEqual:@"fixture app"], @"stable capture must publish the materialized app tree");
    }
    require(captureCount == expectedCaptures, @"covered apps must be refused before native acquisition");
  }
  return 0;
}
