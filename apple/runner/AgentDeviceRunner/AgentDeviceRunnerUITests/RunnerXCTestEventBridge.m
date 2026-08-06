#import "RunnerXCTestEventBridge.h"

NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  NSString *surface,
  RunnerXCTestEventBridge *bridge
) {
  Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
  Class pathClass = NSClassFromString(@"XCPointerEventPath");
  SEL addPathSelector = NSSelectorFromString(@"addPointerEventPath:");
  SEL setTargetProcessIDSelector = NSSelectorFromString(@"setTargetProcessID:");
  SEL synthesizeSelector = NSSelectorFromString(@"synthesizeWithError:");
  SEL processIDSelector = NSSelectorFromString(@"processID");

  NSString *missing = RunnerRequireClass(recordClass, @"XCSynthesizedEventRecord", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireClass(pathClass, @"XCPointerEventPath", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, addPathSelector, @"addPointerEventPath:", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(
    recordClass, setTargetProcessIDSelector, @"setTargetProcessID:", surface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, synthesizeSelector, @"synthesizeWithError:", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireApplicationSelector(application, processIDSelector, @"processID", surface);
  if (missing != nil) return missing;

  *bridge = (RunnerXCTestEventBridge){
    .recordClass = recordClass,
    .pathClass = pathClass,
    .addPathSelector = addPathSelector,
    .setTargetProcessIDSelector = setTargetProcessIDSelector,
    .synthesizeSelector = synthesizeSelector,
    .processIDSelector = processIDSelector,
  };
  return nil;
}

NSString * _Nullable RunnerRequireClass(Class cls, NSString *className, NSString *surface) {
  if (cls == Nil) {
    return [NSString stringWithFormat:
      @"private XCTest %@ synthesis unavailable: missing %@",
      surface,
      className
    ];
  }
  return nil;
}

NSString * _Nullable RunnerRequireSelector(
  Class cls,
  SEL selector,
  NSString *selectorName,
  NSString *surface
) {
  if (![cls instancesRespondToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest %@ synthesis unavailable: %@ missing %@",
      surface,
      NSStringFromClass(cls),
      selectorName
    ];
  }
  return nil;
}

NSString * _Nullable RunnerRequireApplicationSelector(
  id application,
  SEL selector,
  NSString *selectorName,
  NSString *surface
) {
  if (![application respondsToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest %@ synthesis unavailable: XCUIApplication missing %@",
      surface,
      selectorName
    ];
  }
  return nil;
}

NSString *RunnerFormatXCTestException(NSException *exception, NSString *fallbackReason) {
  NSString *name = exception.name ?: @"NSException";
  NSString *reason = exception.reason ?: fallbackReason;
  return [NSString stringWithFormat:@"%@: %@", name, reason];
}
