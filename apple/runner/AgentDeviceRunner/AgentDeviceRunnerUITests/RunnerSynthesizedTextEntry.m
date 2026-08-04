#import "RunnerSynthesizedTextEntry.h"

#import <objc/message.h>

typedef NSInteger (*RunnerTextMsgSendInteger)(id, SEL);
typedef id (*RunnerTextMsgSendInit)(id, SEL, NSString *);
typedef id (*RunnerTextMsgSendInitPath)(id, SEL);
typedef void (*RunnerTextMsgSendType)(id, SEL, NSString *, NSTimeInterval, NSUInteger, BOOL);
typedef void (*RunnerTextMsgSendTypeKey)(id, SEL, NSString *, NSUInteger, NSTimeInterval);
typedef void (*RunnerTextMsgSendObject)(id, SEL, id);
typedef void (*RunnerTextMsgSendSetInteger)(id, SEL, NSInteger);
typedef BOOL (*RunnerTextMsgSendSynthesize)(id, SEL, NSError **);

static NSString * _Nullable RunnerRequireTextClass(Class cls, NSString *name);
static NSString * _Nullable RunnerRequireTextSelector(Class cls, SEL selector, NSString *name);
static RunnerSynthesizedTextEntryResult *RunnerTextEntryResult(
  RunnerSynthesizedTextEntryStatus status,
  NSString * _Nullable message
);
static RunnerSynthesizedTextEntryResult *RunnerTextEntryUnavailable(NSString *message);
static RunnerSynthesizedTextEntryResult *RunnerTextEntryFailed(NSString *message);
static RunnerSynthesizedTextEntryResult *RunnerSynthesizeTextWithMode(
  id application,
  NSString *text,
  BOOL replace
);

@interface RunnerSynthesizedTextEntryResult ()

@property(nonatomic, readwrite) RunnerSynthesizedTextEntryStatus status;
@property(nonatomic, readwrite, nullable) NSString *message;

@end


@implementation RunnerSynthesizedTextEntryResult
@end

@implementation RunnerSynthesizedTextEntry

+ (RunnerSynthesizedTextEntryResult *)synthesizeTextWithApplication:(id)application
                                                               text:(NSString *)text {
  return RunnerSynthesizeTextWithMode(application, text, NO);
}

+ (RunnerSynthesizedTextEntryResult *)replaceTextWithApplication:(id)application
                                                           text:(NSString *)text {
  return RunnerSynthesizeTextWithMode(application, text, YES);
}

@end

static RunnerSynthesizedTextEntryResult *RunnerSynthesizeTextWithMode(
  id application,
  NSString *text,
  BOOL replace
) {
  @try {
    Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
    Class pathClass = NSClassFromString(@"XCPointerEventPath");
    SEL initRecord = NSSelectorFromString(@"initWithName:");
    SEL initPath = NSSelectorFromString(@"initForTextInput");
    SEL typeText = NSSelectorFromString(@"typeText:atOffset:typingSpeed:shouldRedact:");
    SEL typeKey = NSSelectorFromString(@"typeKey:modifiers:atOffset:");
    SEL addPath = NSSelectorFromString(@"addPointerEventPath:");
    SEL setTargetProcessID = NSSelectorFromString(@"setTargetProcessID:");
    SEL synthesize = NSSelectorFromString(@"synthesizeWithError:");
    SEL processID = NSSelectorFromString(@"processID");

    NSString *missing = RunnerRequireTextClass(recordClass, @"XCSynthesizedEventRecord");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    missing = RunnerRequireTextClass(pathClass, @"XCPointerEventPath");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    missing = RunnerRequireTextSelector(recordClass, initRecord, @"initWithName:");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    missing = RunnerRequireTextSelector(recordClass, addPath, @"addPointerEventPath:");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    missing = RunnerRequireTextSelector(recordClass, setTargetProcessID, @"setTargetProcessID:");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    missing = RunnerRequireTextSelector(recordClass, synthesize, @"synthesizeWithError:");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    missing = RunnerRequireTextSelector(pathClass, initPath, @"initForTextInput");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    missing = RunnerRequireTextSelector(pathClass, typeText, @"typeText:atOffset:typingSpeed:shouldRedact:");
    if (missing != nil) return RunnerTextEntryUnavailable(missing);
    if (replace) {
      missing = RunnerRequireTextSelector(pathClass, typeKey, @"typeKey:modifiers:atOffset:");
      if (missing != nil) return RunnerTextEntryUnavailable(missing);
    }
    if (![application respondsToSelector:processID]) {
      return RunnerTextEntryUnavailable(
        @"private XCTest text synthesis unavailable: XCUIApplication missing processID"
      );
    }

    NSInteger targetProcessID =
      ((RunnerTextMsgSendInteger)objc_msgSend)(application, processID);
    if (targetProcessID <= 0) {
      return RunnerTextEntryUnavailable(
        @"private XCTest text synthesis unavailable: could not resolve target process ID"
      );
    }

    if (replace) {
      id selectionRecord = ((RunnerTextMsgSendInit)objc_msgSend)(
        [recordClass alloc], initRecord, @"agent-device-fill-select-all"
      );
      id selectionPath = ((RunnerTextMsgSendInitPath)objc_msgSend)([pathClass alloc], initPath);
      if (selectionRecord == nil || selectionPath == nil) {
        return RunnerTextEntryFailed(
          @"private XCTest text synthesis failed: could not create the selection event"
        );
      }
      ((RunnerTextMsgSendSetInteger)objc_msgSend)(
        selectionRecord, setTargetProcessID, targetProcessID
      );
      // XCUIKeyModifierCommand is public XCTest API (1 << 4). Keeping the value local
      // avoids importing XCUIAutomation headers into the bridging helper. A text-input
      // path only performs its first operation reliably, so selection and replacement
      // use ordered records rather than one multi-operation path.
      NSUInteger commandModifier = 1UL << 4;
      ((RunnerTextMsgSendTypeKey)objc_msgSend)(
        selectionPath, typeKey, @"a", commandModifier, 0.0
      );
      ((RunnerTextMsgSendObject)objc_msgSend)(selectionRecord, addPath, selectionPath);
      NSError *selectionError = nil;
      BOOL selected = ((RunnerTextMsgSendSynthesize)objc_msgSend)(
        selectionRecord, synthesize, &selectionError
      );
      if (!selected) {
        NSString *detail = selectionError.localizedDescription ?: @"synthesizeWithError returned false";
        return RunnerTextEntryFailed(
          [NSString stringWithFormat:@"private XCTest text selection failed: %@", detail]
        );
      }
    }

    id record = ((RunnerTextMsgSendInit)objc_msgSend)(
      [recordClass alloc], initRecord, replace ? @"agent-device-fill-text" : @"agent-device-type"
    );
    id path = ((RunnerTextMsgSendInitPath)objc_msgSend)([pathClass alloc], initPath);
    if (record == nil || path == nil) {
      return RunnerTextEntryFailed(
        @"private XCTest text synthesis failed: could not create the text event"
      );
    }
    ((RunnerTextMsgSendSetInteger)objc_msgSend)(record, setTargetProcessID, targetProcessID);
    ((RunnerTextMsgSendType)objc_msgSend)(path, typeText, text, 0.0, 60, YES);
    ((RunnerTextMsgSendObject)objc_msgSend)(record, addPath, path);

    NSError *error = nil;
    BOOL ok = ((RunnerTextMsgSendSynthesize)objc_msgSend)(record, synthesize, &error);
    if (!ok) {
      NSString *detail = error.localizedDescription ?: @"synthesizeWithError returned false";
      return RunnerTextEntryFailed(
        [NSString stringWithFormat:@"private XCTest text synthesis failed: %@", detail]
      );
    }
    return RunnerTextEntryResult(RunnerSynthesizedTextEntryStatusSucceeded, nil);
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"private XCTest text synthesis failed";
    return RunnerTextEntryFailed([NSString stringWithFormat:@"%@: %@", name, reason]);
  }
}

static RunnerSynthesizedTextEntryResult *RunnerTextEntryResult(
  RunnerSynthesizedTextEntryStatus status,
  NSString * _Nullable message
) {
  RunnerSynthesizedTextEntryResult *result = [RunnerSynthesizedTextEntryResult new];
  result.status = status;
  result.message = message;
  return result;
}

static RunnerSynthesizedTextEntryResult *RunnerTextEntryUnavailable(NSString *message) {
  return RunnerTextEntryResult(RunnerSynthesizedTextEntryStatusUnavailable, message);
}

static RunnerSynthesizedTextEntryResult *RunnerTextEntryFailed(NSString *message) {
  return RunnerTextEntryResult(RunnerSynthesizedTextEntryStatusFailed, message);
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
