#import "RunnerSynthesizedTextEntry.h"

#import <objc/message.h>

typedef NSInteger (*RunnerTextMsgSendInteger)(id, SEL);
typedef id (*RunnerTextMsgSendInit)(id, SEL, NSString *);
typedef id (*RunnerTextMsgSendInitPath)(id, SEL);
typedef void (*RunnerTextMsgSendType)(id, SEL, NSString *, NSTimeInterval, NSUInteger, BOOL);
typedef void (*RunnerTextMsgSendObject)(id, SEL, id);
typedef void (*RunnerTextMsgSendSetInteger)(id, SEL, NSInteger);
typedef BOOL (*RunnerTextMsgSendSynthesize)(id, SEL, NSError **);

static NSString * _Nullable RunnerRequireTextClass(Class cls, NSString *name);
static NSString * _Nullable RunnerRequireTextSelector(Class cls, SEL selector, NSString *name);

@implementation RunnerSynthesizedTextEntry

+ (NSString * _Nullable)synthesizeTextWithApplication:(id)application
                                                    text:(NSString *)text {
  @try {
    Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
    Class pathClass = NSClassFromString(@"XCPointerEventPath");
    SEL initRecord = NSSelectorFromString(@"initWithName:");
    SEL initPath = NSSelectorFromString(@"initForTextInput");
    SEL typeText = NSSelectorFromString(@"typeText:atOffset:typingSpeed:shouldRedact:");
    SEL addPath = NSSelectorFromString(@"addPointerEventPath:");
    SEL setTargetProcessID = NSSelectorFromString(@"setTargetProcessID:");
    SEL synthesize = NSSelectorFromString(@"synthesizeWithError:");
    SEL processID = NSSelectorFromString(@"processID");

    NSString *missing = RunnerRequireTextClass(recordClass, @"XCSynthesizedEventRecord");
    if (missing != nil) return missing;
    missing = RunnerRequireTextClass(pathClass, @"XCPointerEventPath");
    if (missing != nil) return missing;
    missing = RunnerRequireTextSelector(recordClass, initRecord, @"initWithName:");
    if (missing != nil) return missing;
    missing = RunnerRequireTextSelector(recordClass, addPath, @"addPointerEventPath:");
    if (missing != nil) return missing;
    missing = RunnerRequireTextSelector(recordClass, setTargetProcessID, @"setTargetProcessID:");
    if (missing != nil) return missing;
    missing = RunnerRequireTextSelector(recordClass, synthesize, @"synthesizeWithError:");
    if (missing != nil) return missing;
    missing = RunnerRequireTextSelector(pathClass, initPath, @"initForTextInput");
    if (missing != nil) return missing;
    missing = RunnerRequireTextSelector(pathClass, typeText, @"typeText:atOffset:typingSpeed:shouldRedact:");
    if (missing != nil) return missing;
    if (![application respondsToSelector:processID]) {
      return @"private XCTest text synthesis unavailable: XCUIApplication missing processID";
    }

    NSInteger targetProcessID =
      ((RunnerTextMsgSendInteger)objc_msgSend)(application, processID);
    if (targetProcessID <= 0) {
      return @"private XCTest text synthesis unavailable: could not resolve target process ID";
    }

    id record = ((RunnerTextMsgSendInit)objc_msgSend)(
      [recordClass alloc], initRecord, @"agent-device-type"
    );
    id path = ((RunnerTextMsgSendInitPath)objc_msgSend)([pathClass alloc], initPath);
    if (record == nil || path == nil) {
      return @"private XCTest text synthesis failed: could not create the text event";
    }
    ((RunnerTextMsgSendSetInteger)objc_msgSend)(record, setTargetProcessID, targetProcessID);
    ((RunnerTextMsgSendType)objc_msgSend)(path, typeText, text, 0.0, 60, YES);
    ((RunnerTextMsgSendObject)objc_msgSend)(record, addPath, path);

    NSError *error = nil;
    BOOL ok = ((RunnerTextMsgSendSynthesize)objc_msgSend)(record, synthesize, &error);
    if (!ok) {
      NSString *detail = error.localizedDescription ?: @"synthesizeWithError returned false";
      return [NSString stringWithFormat:@"private XCTest text synthesis failed: %@", detail];
    }
    return nil;
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"private XCTest text synthesis failed";
    return [NSString stringWithFormat:@"%@: %@", name, reason];
  }
}

static NSString * _Nullable RunnerRequireTextClass(Class cls, NSString *name) {
  if (cls == Nil) {
    return [NSString stringWithFormat:@"private XCTest text synthesis unavailable: missing %@", name];
  }
  return nil;
}

static NSString * _Nullable RunnerRequireTextSelector(Class cls, SEL selector, NSString *name) {
  if (![cls instancesRespondToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest text synthesis unavailable: %@ missing %@",
      NSStringFromClass(cls),
      name
    ];
  }
  return nil;
}

@end
