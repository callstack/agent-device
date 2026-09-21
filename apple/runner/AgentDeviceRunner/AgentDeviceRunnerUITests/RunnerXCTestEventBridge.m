#import "RunnerXCTestEventBridge.h"
#import "RunnerObjCExceptionCatcher.h"
#import <CoreGraphics/CoreGraphics.h>
#import <math.h>

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

static BOOL RunnerUsableWindowFrame(CGRect frame) {
  if (CGRectIsEmpty(frame) || CGRectIsInfinite(frame) || CGRectIsNull(frame)) {
    return NO;
  }
  return isfinite(frame.origin.x) && isfinite(frame.origin.y)
    && isfinite(frame.size.width) && isfinite(frame.size.height);
}

static NSString *RunnerApplicationScreenFailureDescription(
  RunnerApplicationScreenFailure failure
) {
  switch (failure) {
    case RunnerApplicationScreenFailureUnresolvedWindow:
      return @"no resolved application window";
    case RunnerApplicationScreenFailureUnresolvedScreen:
      return @"no resolved window display ID";
    case RunnerApplicationScreenFailureNone:
      return @"application screen resolved";
  }
}

// One window read. XCTest answers with a value or raises. The window object is handed back because
// resolving this instance is what its `screen` will answer from — re-querying `firstMatch` would
// return an unresolved element that still names the main screen.
//
// Both answers are required. An app with no window answers `frame` with `(0,0 0x0)` without raising,
// which geometry alone would read as a window the runtime has not measured, and only the query
// itself says whether it has one. Measured on a live Duo: the runner host process, which has no
// window, answers `exists` NO and `frame` `(0,0 0x0)` (#2728).
//
// The frame the read produced is reported even when it is refused: a capture that fails closed has
// to say what it looked at, or the reason code cannot be told apart from a stale device.
static RunnerApplicationScreenFailure RunnerResolveUsableWindow(
  id application,
  id _Nullable *window,
  CGRect *observedFrame
) {
  __block id readWindow = nil;
  __block CGRect frame = CGRectNull;
  __block BOOL resolved = NO;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    id candidate = [[application valueForKey:@"windows"] valueForKey:@"firstMatch"];
    NSNumber *present = [candidate valueForKey:@"exists"];
    resolved = [present isKindOfClass:NSNumber.class] && present.boolValue;
    NSValue *frameValue = [candidate valueForKey:@"frame"];
    [frameValue getValue:&frame size:sizeof(frame)];
    readWindow = candidate;
  }];
  *observedFrame = frame;
  if (exception != nil || !resolved || !RunnerUsableWindowFrame(frame)) {
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=window frame=(%g,%g %gx%g) raised=%@ resolved=%@",
      frame.origin.x,
      frame.origin.y,
      frame.size.width,
      frame.size.height,
      exception != nil ? @"yes" : @"no",
      resolved ? @"yes" : @"no"
    );
    return RunnerApplicationScreenFailureUnresolvedWindow;
  }
  *window = readWindow;
  return RunnerApplicationScreenFailureNone;
}

// The screen read that must follow window resolution on that same window instance. Before the
// frame above is asked for, the window's `screen` can still name main, so this is never merged
// into the read ahead of it.
static RunnerApplicationScreenFailure RunnerReadResolvedWindowScreen(
  id window,
  CGRect windowFrame,
  id _Nullable *screen,
  NSUInteger *displayID
) {
  __block id readScreen = nil;
  __block NSUInteger readDisplayID = 0;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    id windowScreen = [window valueForKey:@"screen"];
    NSNumber *identifier = [windowScreen valueForKey:@"displayID"];
    if (![identifier isKindOfClass:NSNumber.class] || identifier.unsignedIntegerValue == 0) {
      return;
    }
    readScreen = windowScreen;
    readDisplayID = identifier.unsignedIntegerValue;
  }];
  if (exception != nil || readScreen == nil) {
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=screen frame=(%g,%g %gx%g) raised=%@",
      windowFrame.origin.x,
      windowFrame.origin.y,
      windowFrame.size.width,
      windowFrame.size.height,
      exception != nil ? @"yes" : @"no"
    );
    return RunnerApplicationScreenFailureUnresolvedScreen;
  }
  *screen = readScreen;
  *displayID = readDisplayID;
  return RunnerApplicationScreenFailureNone;
}

BOOL RunnerResolveApplicationScreen(
  id application,
  id _Nullable *screen,
  NSUInteger *displayID,
  RunnerApplicationScreenFailure *failure
) {
  *screen = nil;
  *displayID = 0;
  id window = nil;
  CGRect windowFrame = CGRectNull;
  *failure = RunnerResolveUsableWindow(application, &window, &windowFrame);
  if (*failure != RunnerApplicationScreenFailureNone) {
    return NO;
  }
  *failure = RunnerReadResolvedWindowScreen(window, windowFrame, screen, displayID);
  return *failure == RunnerApplicationScreenFailureNone;
}

// Reads the display ID off a window the caller already resolved, so a synthesized record can be
// routed by the same window its reference frame was measured on. The window still resolves here:
// its frame is read before its screen, and a window that answers empty or raises fails closed with
// the same reasons the application walk gives.
NSString * _Nullable RunnerResolveWindowDisplayID(id window, NSUInteger *displayID) {
  NSValue *frameValue = [window valueForKey:@"frame"];
  CGRect frame = CGRectNull;
  [frameValue getValue:&frame size:sizeof(frame)];
  if (!RunnerUsableWindowFrame(frame)) {
    return [NSString stringWithFormat:
      @"private XCTest event synthesis unavailable: %@",
      RunnerApplicationScreenFailureDescription(RunnerApplicationScreenFailureUnresolvedWindow)
    ];
  }
  id screen = nil;
  NSUInteger resolvedDisplayID = 0;
  RunnerApplicationScreenFailure failure =
    RunnerReadResolvedWindowScreen(window, frame, &screen, &resolvedDisplayID);
  if (failure != RunnerApplicationScreenFailureNone) {
    return [NSString stringWithFormat:
      @"private XCTest event synthesis unavailable: %@",
      RunnerApplicationScreenFailureDescription(failure)
    ];
  }
  *displayID = resolvedDisplayID;
  return nil;
}
