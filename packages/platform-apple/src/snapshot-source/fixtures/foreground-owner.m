#import "SnapshotBridgeRuntime.h"

@interface BridgeRuntime (ForegroundOwner)
- (BOOL)isPrimaryForegroundProcess:(pid_t)pid;
@end

static id primaryApplication;

@interface AXElement : NSObject
@property(nonatomic) pid_t pid;
+ (id)primaryApp;
@end

@implementation AXElement
+ (id)primaryApp { return primaryApplication; }
@end

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

int main(void)
{
  @autoreleasepool {
    BridgeRuntime *runtime = [BridgeRuntime new];
    AXElement *target = [AXElement new];
    target.pid = 42;
    AXElement *system = [AXElement new];
    system.pid = 7;

    primaryApplication = target;
    require([runtime isPrimaryForegroundProcess:42], @"primary target must be admitted");
    primaryApplication = system;
    require(![runtime isPrimaryForegroundProcess:42], @"covered target must be refused");
    primaryApplication = nil;
    require(![runtime isPrimaryForegroundProcess:42], @"missing ownership must be refused");
    primaryApplication = @"invalid";
    require(![runtime isPrimaryForegroundProcess:42], @"malformed ownership must be refused");
    primaryApplication = [NSNull null];
    require(![runtime isPrimaryForegroundProcess:42], @"owner without pid must be refused");
    primaryApplication = target;
    require([runtime isPrimaryForegroundProcess:42], @"ownership must be observed again after dismissal");
  }
  return 0;
}
