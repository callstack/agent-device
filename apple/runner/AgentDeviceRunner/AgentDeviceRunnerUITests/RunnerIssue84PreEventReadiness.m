#import "RunnerIssue84PreEventReadiness.h"

#import <TargetConditionals.h>
#import <objc/message.h>

NSString * _Nullable RunnerIssue84WaitForPreEventReadiness(id application) {
#if TARGET_OS_IOS
  id target = application;
  for (NSString *name in @[@"applicationImpl", @"currentProcess"]) {
    SEL selector = NSSelectorFromString(name);
    if (![target respondsToSelector:selector]) {
      return [NSString stringWithFormat:@"pre-event readiness diagnostic missing %@", name];
    }
    target = ((id (*)(id, SEL))objc_msgSend)(target, selector);
  }
  SEL wait = NSSelectorFromString(@"waitForQuiescenceIncludingAnimationsIdle:isPreEvent:");
  if (![target respondsToSelector:wait]) {
    return @"pre-event readiness diagnostic missing two-argument quiescence method";
  }
  NSTimeInterval startedAt = NSProcessInfo.processInfo.systemUptime;
  NSLog(@"ISSUE84_PRE_EVENT_READINESS started");
  ((void (*)(id, SEL, BOOL, BOOL))objc_msgSend)(target, wait, YES, YES);
  NSLog(@"ISSUE84_PRE_EVENT_READINESS completed elapsedMs=%.0f",
    (NSProcessInfo.processInfo.systemUptime - startedAt) * 1000);
#endif
  return nil;
}
